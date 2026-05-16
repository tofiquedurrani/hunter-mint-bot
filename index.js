require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const schedule = require("node-schedule");
const { parseCollectionUrl, getCollection, getCheapestListings } = require("./src/opensea");
const { NFTBuyer } = require("./src/buyer");
const { CollectionMonitor } = require("./src/monitor");
const REQUIRED = ["TELEGRAM_BOT_TOKEN","OPENSEA_API_KEY","WALLET_PRIVATE_KEY","ETH_RPC_URL"];
for (const key of REQUIRED) { if (!process.env[key]) { console.error(`❌  Missing env: ${key}`); process.exit(1); } }
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const buyer = new NFTBuyer();
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "").split(",").map((id) => Number(id.trim())).filter(Boolean);
const sessions = new Map();
const monitors = new Map();
// Tracks pending scheduled mints: uid -> [ { id, label, openTime, job } ]
const scheduledMints = new Map();
function getSession(userId) { if (!sessions.has(userId)) sessions.set(userId, {}); return sessions.get(userId); }
function clearSession(userId) { sessions.set(userId, {}); }
function addScheduledMint(uid, entry) {
  if (!scheduledMints.has(uid)) scheduledMints.set(uid, []);
  scheduledMints.get(uid).push(entry);
}
function removeScheduledMint(uid, id) {
  if (!scheduledMints.has(uid)) return;
  const list = scheduledMints.get(uid).filter(e => e.id !== id);
  scheduledMints.set(uid, list);
}
bot.use((ctx, next) => {
  const uid = ctx.from?.id;
  if (ALLOWED_USERS.length > 0 && !ALLOWED_USERS.includes(uid)) return ctx.reply("⛔  Unauthorized. Ask the bot owner to whitelist your ID: " + uid);
  return next();
});
bot.start(async (ctx) => {
  clearSession(ctx.from.id);
  const balance = await buyer.getBalance().catch(() => "?");
  await ctx.replyWithHTML(`🎯 <b>Hunter Mint Bot</b>\n\n👛 Wallet: <code>${buyer.address}</code>\n💰 Balance: <b>${parseFloat(balance).toFixed(4)} ETH</b>\n\nSend me an <b>OpenSea collection URL</b> to begin.\n\nExample:\n<code>https://opensea.io/collection/slonks</code>\n\n✅  <b>Free Mint supported!</b> — Bot will detect if collection has free mint.\n\nCommands: /status /scheduled /stop /wallet`);
});
bot.command("status", async (ctx) => {
  const uid = ctx.from.id;
  const mon = monitors.get(uid);
  const balance = await buyer.getBalance().catch(() => "?");
  if (mon && mon.running) {
    await ctx.replyWithHTML(`📊 <b>Monitor Active</b>\n\n🎯 Collection: <code>${mon.slug}</code>\n💸 Max price: ${mon.maxPriceEth} ETH\n🔢 Qty: ${mon.quantity}\n🔄 Polls: ${mon.pollCount}\n✅  Bought: ${mon.bought}/${mon.quantity}\n💰 Wallet: ${parseFloat(balance).toFixed(4)} ETH`);
  } else {
    await ctx.replyWithHTML(`💤 <b>No active monitor</b>\n💰 Wallet: ${parseFloat(balance).toFixed(4)} ETH`);
  }
});
bot.command("scheduled", async (ctx) => {
  const uid = ctx.from.id;
  const list = (scheduledMints.get(uid) || []).filter(e => e.job.nextInvocation() !== null);
  if (list.length === 0) {
    return ctx.replyWithHTML(`📭 <b>No pending scheduled mints.</b>\n\nUse Free Mint mode on a collection to auto-schedule one.`);
  }
  const now = Date.now();
  let msg = `⏰ <b>Pending Scheduled Mints (${list.length})</b>\n\n`;
  list.forEach((e, i) => {
    const msLeft = e.openTime - now;
    const minsLeft = Math.max(0, Math.round(msLeft / 60000));
    const hLeft = Math.floor(minsLeft / 60);
    const mLeft = minsLeft % 60;
    const timeLeft = hLeft > 0 ? `${hLeft}h ${mLeft}m` : `${mLeft}m`;
    msg += `${i + 1}. <b>${e.label}</b>\n`;
    msg += `   🕐 Opens: ${new Date(e.openTime).toLocaleString()}\n`;
    msg += `   ⏱ Time left: ~${timeLeft}\n`;
    msg += `   🔢 Qty: ${e.quantity}\n`;
    msg += `   ❌ Cancel: /cancel_${e.id}\n\n`;
  });
  msg += `Use /stopall to cancel all pending mints.`;
  await ctx.replyWithHTML(msg);
});
bot.command("stopall", (ctx) => {
  const uid = ctx.from.id;
  const list = scheduledMints.get(uid) || [];
  let cancelled = 0;
  for (const e of list) { try { e.job.cancel(); cancelled++; } catch {} }
  scheduledMints.set(uid, []);
  const mon = monitors.get(uid);
  if (mon) { mon.stop(); monitors.delete(uid); }
  clearSession(uid);
  ctx.reply(`🛑 Cancelled ${cancelled} scheduled mint(s) and stopped any active monitor.`);
});
bot.command("stop", (ctx) => {
  const uid = ctx.from.id;
  const mon = monitors.get(uid);
  if (mon) { mon.stop(); monitors.delete(uid); ctx.reply("🛑 Monitor stopped."); }
  else ctx.reply("No active monitor. Use /scheduled to see pending mints, /stopall to cancel them.");
  clearSession(uid);
});
bot.command("wallet", async (ctx) => {
  const balance = await buyer.getBalance().catch(() => "?");
  await ctx.replyWithHTML(`👛 <b>Wallet Info</b>\n\nAddress: <code>${buyer.address}</code>\nBalance: <b>${parseFloat(balance).toFixed(6)} ETH</b>`);
});
// Dynamic /cancel_<id> handler
bot.on("text", async (ctx) => {
  const uid = ctx.from.id;
  const text = ctx.message.text.trim();
  const sess = getSession(uid);
  // Handle /cancel_<id> commands
  const cancelMatch = text.match(/^\/cancel_(\d+)$/);
  if (cancelMatch) {
    const id = parseInt(cancelMatch[1]);
    const list = scheduledMints.get(uid) || [];
    const entry = list.find(e => e.id === id);
    if (!entry) return ctx.reply("❓ Scheduled mint not found. Use /scheduled to see the list.");
    try { entry.job.cancel(); } catch {}
    removeScheduledMint(uid, id);
    return ctx.replyWithHTML(`✅ Cancelled scheduled mint for <b>${entry.label}</b>.`);
  }
  if (text.startsWith("/")) return;
  if (!sess.slug) {
    const slug = parseCollectionUrl(text);
    if (!slug) return ctx.reply("❓  Send a valid OpenSea collection URL.\nExample: https://opensea.io/collection/slonks");
    const loadMsg = await ctx.reply("🔍 Fetching collection info...");
    try {
      const col = await getCollection(slug);
      sess.slug = col.slug; sess.collection = col;
      const chainEmoji = col.chain === "ethereum" ? "⟠" : col.chain === "polygon" ? "💜" : "🔵";
      await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      let mintInfo = null; let freeMintLine = "";
      if (col.contractAddress) {
        try {
          mintInfo = await buyer.detectMintInfo(col.contractAddress);
          sess.mintInfo = mintInfo;
          if (mintInfo.isFree) freeMintLine = `\n🆓 <b>FREE MINT detected!</b> (only gas fee)\n`;
          else if (mintInfo.mintPrice !== null && mintInfo.mintPrice > 0n) freeMintLine = `\n💎 Mint price: ${parseFloat((Number(mintInfo.mintPrice) / 1e18).toFixed(6))} ETH per NFT\n`;
        } catch {}
      }
      await ctx.replyWithHTML(`✅  <b>${col.name}</b>\n\n${chainEmoji} Chain: ${col.chain.charAt(0).toUpperCase() + col.chain.slice(1)}\n` + (col.floorPrice ? `📊 Floor: ${col.floorPrice} ETH\n` : "") + (col.numOwners ? `👥 Owners: ${col.numOwners.toLocaleString()}\n` : "") + (col.contractAddress ? `📋 Contract: <code>${col.contractAddress}</code>\n` : `⚠️ Contract address not found\n`) + freeMintLine + `\n💸 <b>Max price per NFT in ETH?</b>\n(For free mint, enter <b>0</b>)`);
    } catch (err) {
      await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id).catch(() => {});
      return ctx.reply(`❌  ${err.message}`);
    }
    return;
  }
  if (!sess.maxPrice && sess.maxPrice !== 0) {
    const price = parseFloat(text);
    if (isNaN(price) || price < 0) return ctx.reply("❌  Enter a valid ETH price. Example: 0.005 (or 0 for free mint)");
    if (price > 0) {
      const balance = parseFloat(await buyer.getBalance().catch(() => "0"));
      if (balance < price) return ctx.replyWithHTML(`⚠️ <b>Low balance!</b>\nWallet: ${balance.toFixed(4)} ETH\nYour max: ${price} ETH\n\nContinue anyway? Enter quantity to proceed.`);
    }
    sess.maxPrice = price;
    await ctx.reply(`🔢 How many NFTs do you want to mint?`, Markup.keyboard([["1"], ["2", "3"], ["5", "10"]]).oneTime().resize());
    return;
  }
  if (!sess.quantity) {
    const qty = parseInt(text);
    if (isNaN(qty) || qty < 1 || qty > 50) return ctx.reply("❌  Enter quantity 1-50.");
    sess.quantity = qty;
    const rows = [["⚡  Instant buy"], ["📋 Queue / monitor"]];
    if (sess.collection?.contractAddress) rows.unshift(["🆓 Free Mint (direct contract)"]);
    rows.push(["⏰  10 minutes", "🕐 1 hour"], ["✏️ Specify time"]);
    await ctx.reply(`⚡  Pick the strike mode:`, Markup.keyboard(rows).oneTime().resize());
    return;
  }
  if (!sess.mode) {
    if (text.includes("Free Mint")) { sess.mode = "freemint"; await executeFreeMint(ctx, uid, sess); clearSession(uid); }
    else if (text.includes("Instant")) { sess.mode = "instant"; await executeInstant(ctx, uid, sess); clearSession(uid); }
    else if (text.includes("Queue") || text.includes("monitor")) { sess.mode = "monitor"; await startMonitor(ctx, uid, sess); clearSession(uid); }
    else if (text.includes("10 minutes")) { sess.mode = "schedule"; sess.scheduleDate = new Date(Date.now() + 10 * 60 * 1000); await scheduleExecution(ctx, uid, sess); clearSession(uid); }
    else if (text.includes("1 hour")) { sess.mode = "schedule"; sess.scheduleDate = new Date(Date.now() + 60 * 60 * 1000); await scheduleExecution(ctx, uid, sess); clearSession(uid); }
    else if (text.includes("Specify")) { sess.mode = "specify_time"; await ctx.reply("✏️ Send the time in format: HH:MM (24hr) or minutes from now.\nExample: 14:30 or 45"); }
    else return ctx.reply("❓  Please pick a mode from the keyboard.");
    return;
  }
  if (sess.mode === "specify_time") {
    let targetDate = null;
    if (/^\d{1,2}:\d{2}$/.test(text)) { const [h, m] = text.split(":").map(Number); targetDate = new Date(); targetDate.setHours(h, m, 0, 0); if (targetDate <= new Date()) targetDate.setDate(targetDate.getDate() + 1); }
    else if (/^\d+$/.test(text)) targetDate = new Date(Date.now() + parseInt(text) * 60 * 1000);
    if (!targetDate) return ctx.reply("❌  Invalid format. Use HH:MM (e.g. 14:30) or minutes (e.g. 45)");
    sess.scheduleDate = targetDate; sess.mode = "schedule";
    await scheduleExecution(ctx, uid, sess); clearSession(uid);
  }
});
let _jobIdCounter = 1;
async function executeFreeMint(ctx, uid, sess) {
  const contractAddress = sess.collection?.contractAddress;
  const chain = sess.collection?.chain || "ethereum";
  if (!contractAddress) return ctx.reply("❌  Contract address not found for this collection.\nTry Instant Buy mode instead.");
  const chainEmoji = chain === "base" ? "🔵" : chain === "polygon" ? "💜" : "⟠";
  await ctx.replyWithHTML(`🆓 <b>Starting Free Mint...</b>\n\n${chainEmoji} Chain: <b>${chain.charAt(0).toUpperCase() + chain.slice(1)}</b>\n📋 Contract: <code>${contractAddress}</code>\n🔢 Quantity: ${sess.quantity}\n⛽  You only pay gas fees\n\n🔄 Sending transaction...`, Markup.removeKeyboard());
  const mintPrice = sess.mintInfo?.mintPrice ?? 0n;
  const result = await buyer.freeMint(contractAddress, sess.quantity, mintPrice, chain);
  if (result.success) {
    await ctx.replyWithHTML(`✅  <b>FREE MINT SUCCESS!</b>\n\n${chainEmoji} Chain: ${chain}\n🔢 Quantity: ${result.quantity}\n⛽  Gas only (price: ${result.priceEth} ETH)\n🔧 Function: <code>${result.functionUsed}()</code>\n🔗 <a href="${result.txUrl}">View Transaction</a>`);
  } else if (result.notStarted) {
    const targetDate = new Date(result.startTime * 1000);
    const minsUntil = Math.max(1, Math.round((result.startTime * 1000 - Date.now()) / 60000));
    const jobId = _jobIdCounter++;
    const collectionName = sess.collection?.name || sess.slug || contractAddress.slice(0, 10);
    const savedSess = { ...sess };
    const job = schedule.scheduleJob(targetDate, async () => {
      removeScheduledMint(uid, jobId);
      await ctx.replyWithHTML(`⚡ <b>Mint is open! Firing now...</b>\n📋 <code>${contractAddress}</code>`);
      const retryResult = await buyer.freeMint(contractAddress, savedSess.quantity, savedSess.mintInfo?.mintPrice ?? 0n, chain);
      if (retryResult.success) {
        await ctx.replyWithHTML(`✅  <b>FREE MINT SUCCESS!</b>\n\n${chainEmoji} Chain: ${chain}\n🔢 Quantity: ${retryResult.quantity}\n⛽  Gas only (price: ${retryResult.priceEth} ETH)\n🔧 Function: <code>${retryResult.functionUsed}()</code>\n🔗 <a href="${retryResult.txUrl}">View Transaction</a>`);
      } else {
        await ctx.replyWithHTML(`❌  <b>Auto-mint failed</b>\n\n<code>${retryResult.error}</code>\n\n💡 Send the collection URL again to retry manually.`);
      }
    });
    addScheduledMint(uid, { id: jobId, label: collectionName, openTime: result.startTime * 1000, quantity: sess.quantity, job });
    await ctx.replyWithHTML(`⏰ <b>Mint not open yet — auto-scheduled!</b>\n\n📋 Contract: <code>${contractAddress}</code>\n🕐 Opens at: <b>${targetDate.toLocaleString()}</b>\n⏱ Time left: ~${minsUntil} minute(s)\n🔢 Quantity: ${sess.quantity}\n\n🤖 Bot will fire automatically at open time.\n\nUse /scheduled to view all pending mints.\nUse /cancel_${jobId} to cancel this one.`);
  } else {
    await ctx.replyWithHTML(`❌  <b>Free Mint Failed</b>\n\n<code>${result.error}</code>\n\n💡 Try <b>Instant Buy</b> mode instead to buy from secondary listings.`);
  }
}
async function executeInstant(ctx, uid, sess) {
  await ctx.reply("⚡  Firing instantly...", Markup.removeKeyboard());
  try {
    const listings = await getCheapestListings(sess.slug, sess.maxPrice, sess.quantity);
    if (listings.length === 0) return ctx.replyWithHTML(`😔 No listings found below <b>${sess.maxPrice} ETH</b> right now.\n\n💡 Try:\n• Queue/Monitor mode to wait for one\n• Free Mint mode if this collection has active mint`);
    const toBuy = listings.slice(0, sess.quantity);
    await ctx.replyWithHTML(`🎯 Found <b>${toBuy.length}</b> listing(s)!\n` + toBuy.map((l, i) => `${i + 1}. Token #${l.tokenId} — ${l.priceEth.toFixed(6)} ETH`).join("\n") + "\n\n🔄 Executing transactions...");
    for (const listing of toBuy) {
      const result = await buyer.buyListing(listing, sess.collection?.chain);
      if (result.success) await ctx.replyWithHTML(`✅  <b>BOUGHT!</b> Token #${result.tokenId}\n💰 Price: ${result.priceEth.toFixed(6)} ETH\n🔗 <a href="${result.txUrl}">View Transaction</a>`);
      else await ctx.replyWithHTML(`❌  <b>Failed</b> Token #${listing.tokenId}\n<code>${result.error}</code>`);
    }
  } catch (err) { await ctx.reply(`❌  Error: ${err.message}`); }
}
async function startMonitor(ctx, uid, sess) {
  const existing = monitors.get(uid);
  if (existing) existing.stop();
  await ctx.replyWithHTML(`👁 <b>Monitor started!</b>\n\n🎯 ${sess.collection?.name || sess.slug}\n💸 Max: ${sess.maxPrice} ETH\n🔢 Qty: ${sess.quantity}\n⏱ Polling every ${(Number(process.env.POLL_INTERVAL_MS) || 2000) / 1000}s\n\nUse /stop to cancel.`, Markup.removeKeyboard());
  let lastTickMsg = null;
  const monitor = new CollectionMonitor({
    slug: sess.slug, maxPriceEth: sess.maxPrice, quantity: sess.quantity, chain: sess.collection?.chain || "ethereum",
    onFound: async (listings) => {
      for (const listing of listings) {
        await ctx.replyWithHTML(`🔔 <b>Listing found!</b> Token #${listing.tokenId} @ ${listing.priceEth.toFixed(6)} ETH\n🔄 Buying...`);
        const result = await buyer.buyListing(listing, sess.collection?.chain);
        if (result.success) await ctx.replyWithHTML(`✅  <b>BOUGHT!</b> Token #${result.tokenId}\n💰 Price: ${result.priceEth.toFixed(6)} ETH\n🔗 <a href="${result.txUrl}">View Transaction</a>`);
        else await ctx.replyWithHTML(`❌  Buy failed: <code>${result.error}</code>`);
      }
    },
    onTick: async ({ pollCount, listingsFound, cheapest, bought }) => {
      if (pollCount % 30 === 0) {
        const statusText = `👁 Monitoring... Poll #${pollCount}\n📊 Listings ≤ max: ${listingsFound}\n` + (cheapest ? `📉 Cheapest: ${cheapest.toFixed(6)} ETH\n` : "") + `✅  Bought: ${bought}/${sess.quantity}`;
        try {
          if (lastTickMsg) await ctx.telegram.editMessageText(ctx.chat.id, lastTickMsg, undefined, statusText);
          else { const msg = await ctx.reply(statusText); lastTickMsg = msg.message_id; }
        } catch (_) {}
      }
    },
  });
  monitor.slug = sess.slug; monitor.quantity = sess.quantity;
  monitors.set(uid, monitor); monitor.start();
}
async function scheduleExecution(ctx, uid, sess) {
  const targetDate = sess.scheduleDate;
  const timeStr = targetDate.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  await ctx.replyWithHTML(`⏰  <b>Scheduled!</b>\n\n🎯 ${sess.collection?.name || sess.slug}\n💸 Max: ${sess.maxPrice} ETH × ${sess.quantity}\n🕐 Fires at: <b>${timeStr}</b>\n\nUse /stop to cancel.`, Markup.removeKeyboard());
  const savedSess = { ...sess };
  schedule.scheduleJob(targetDate, async () => {
    await ctx.replyWithHTML(`⚡  <b>Time's up! Executing scheduled hunt...</b>`);
    await executeInstant(ctx, uid, savedSess);
  });
}
bot.catch((err, ctx) => { console.error("Bot error:", err); ctx.reply("⚠️ An error occurred. Try /start to reset.").catch(() => {}); });
bot.launch({ dropPendingUpdates: true }).then(() => {
  console.log("🎯 Hunter Mint Bot running!");
  console.log(`👛 Wallet: ${buyer.address}`);
  console.log(`⏱  Poll interval: ${process.env.POLL_INTERVAL_MS || 2000}ms`);
});
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
