// src/buyer.js
const { ethers } = require("ethers");
const axios = require("axios");
const { getFulfillmentData } = require("./opensea");
const CHAIN_CONFIG = {
  ethereum: { rpc: () => process.env.ETH_RPC_URL || "https://eth.llamarpc.com", explorer: "https://etherscan.io", chainId: 1 },
  base: { rpc: () => process.env.BASE_RPC_URL || "https://mainnet.base.org", explorer: "https://basescan.org", chainId: 8453 },
  polygon: { rpc: () => process.env.POLYGON_RPC_URL || "https://polygon-rpc.com", explorer: "https://polygonscan.com", chainId: 137 },
  matic: { rpc: () => process.env.POLYGON_RPC_URL || "https://polygon-rpc.com", explorer: "https://polygonscan.com", chainId: 137 },
};
function getChainConfig(chain = "ethereum") { return CHAIN_CONFIG[chain.toLowerCase()] || CHAIN_CONFIG.ethereum; }
const SEADROP_V1_ADDRESS = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";
const SEADROP_V1_ABI = [
  "function getPublicDrop(address nftContract) external view returns (uint80 mintPrice, uint48 startTime, uint48 endTime, uint16 maxTotalMintableByWallet, uint16 feeBps, bool restrictFeeRecipients)",
  "function getAllowedFeeRecipients(address nftContract) external view returns (address[])",
  "function getMintStats(address nftContract, address minter) external view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)",
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable",
];
const KNOWN_MINT_SIGS = [
  { sig: "mint(uint256)", args: ["qty"] }, { sig: "mint()", args: [] },
  { sig: "mint(address,uint256)", args: ["addr","qty"] }, { sig: "mint(address)", args: ["addr"] },
  { sig: "mint(uint256,uint256)", args: ["qty","qty"] }, { sig: "publicMint(uint256)", args: ["qty"] },
  { sig: "publicMint()", args: [] }, { sig: "freeMint(uint256)", args: ["qty"] },
  { sig: "freeMint()", args: [] }, { sig: "claim(uint256)", args: ["qty"] },
  { sig: "claim()", args: [] }, { sig: "purchase(uint256)", args: ["qty"] },
  { sig: "mintNFT(uint256)", args: ["qty"] }, { sig: "mintPublic(uint256)", args: ["qty"] },
  { sig: "mintPublic()", args: [] }, { sig: "safeMint(address)", args: ["addr"] },
  { sig: "safeMint(address,uint256)", args: ["addr","qty"] }, { sig: "safeMint(uint256)", args: ["qty"] },
  { sig: "batchMint(uint256)", args: ["qty"] }, { sig: "teamMint(uint256)", args: ["qty"] },
  { sig: "mintTo(address)", args: ["addr"] }, { sig: "mintTo(address,uint256)", args: ["addr","qty"] },
  { sig: "airdrop(uint256)", args: ["qty"] }, { sig: "airdrop(address,uint256)", args: ["addr","qty"] },
  { sig: "allowListMint(uint256)", args: ["qty"] }, { sig: "whitelistMint(uint256)", args: ["qty"] },
  { sig: "presaleMint(uint256)", args: ["qty"] }, { sig: "devMint(uint256)", args: ["qty"] },
  { sig: "giveaway(address,uint256)", args: ["addr","qty"] }, { sig: "mintForAddress(uint256,address)", args: ["qty","addr"] },
];
const SELECTOR_MAP = {};
for (const info of KNOWN_MINT_SIGS) { SELECTOR_MAP[ethers.id(info.sig).slice(0, 10)] = info; }
const SEADROP_DETECT_SELECTORS = new Set(["0x60c308b6", "0x64869dad", "0x840e15d4"]);
const READ_ABI = [
  "function mintPrice() external view returns (uint256)",
  "function price() external view returns (uint256)",
  "function cost() external view returns (uint256)",
  "function paused() external view returns (bool)",
  "function saleIsActive() external view returns (bool)",
];
const PROXY_SLOTS = [
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
];
function extractEIP1167Impl(bytecode) {
  const m = bytecode.slice(2).toLowerCase().match(/363d73([0-9a-f]{40})5af4/);
  return m ? "0x" + m[1] : null;
}
async function getImplementationAddress(address, provider) {
  for (const slot of PROXY_SLOTS) {
    try {
      const val = await provider.getStorage(address, slot);
      if (val && val !== ethers.ZeroHash) {
        const addr = "0x" + val.slice(26);
        if (addr !== "0x0000000000000000000000000000000000000000") return addr;
      }
    } catch {}
  }
  try { const bc = await provider.getCode(address); const impl = extractEIP1167Impl(bc); if (impl) return impl; } catch {}
  return null;
}
async function fetchABIFromEtherscanV2(address, chainId) {
  try {
    const { data } = await axios.get(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getabi&address=${address}&apikey=${process.env.ETHERSCAN_API_KEY || ""}`, { timeout: 8000 });
    if (data.status === "1" && data.result) return JSON.parse(data.result);
    return null;
  } catch { return null; }
}
async function fetchABIFromSourceify(address, chainId) {
  try {
    const { data } = await axios.get(`https://sourcify.dev/server/files/any/${chainId}/${ethers.getAddress(address)}`, { timeout: 8000 });
    const metaFile = data?.files?.find((f) => f.name === "metadata.json");
    if (metaFile) { const meta = JSON.parse(metaFile.content); return meta?.output?.abi || null; }
    return null;
  } catch { return null; }
}
function findMintFunctionsFromABI(abi) {
  const keywords = ["mint", "claim", "buy", "purchase", "free", "public", "airdrop", "drop"];
  return abi.filter((item) => item.type === "function" && keywords.some((kw) => item.name?.toLowerCase().includes(kw)) && ["payable", "nonpayable"].includes(item.stateMutability));
}
async function scanBytecodeSelectors(address, provider) {
  try {
    const bytecode = await provider.getCode(address);
    if (!bytecode || bytecode === "0x") return { mintMatches: [], all: [] };
    const hex = bytecode.slice(2);
    const all = new Set();
    for (let i = 0; i < hex.length - 10; i += 2) { if (hex[i] === "6" && hex[i + 1] === "3") all.add("0x" + hex.slice(i + 2, i + 10)); }
    const mintMatches = [];
    for (const sel of all) { if (SELECTOR_MAP[sel]) mintMatches.push({ selector: sel, ...SELECTOR_MAP[sel] }); }
    return { mintMatches, all: [...all] };
  } catch { return { mintMatches: [], all: [] }; }
}
function buildArgs(argTypes, quantity, walletAddress) { return argTypes.map((t) => t === "qty" ? quantity : t === "addr" ? walletAddress : 0); }
function buildArgsFromABI(inputs, quantity, walletAddress) {
  const args = [];
  for (const input of inputs || []) {
    if (["uint256","uint128","uint64","uint32"].includes(input.type)) args.push(quantity);
    else if (input.type === "address") args.push(walletAddress);
    else if (input.type === "bytes32") args.push(ethers.ZeroHash);
    else if (input.type === "bool") args.push(false);
    else if (input.type === "bytes") args.push("0x");
    else return null;
  }
  return args;
}
async function trySeaDropV1Mint(contractAddress, quantity, wallet, feeData, gasMultiplier, txUrl) {
  try {
    const provider = wallet.provider;
    const seaDropCode = await provider.getCode(SEADROP_V1_ADDRESS);
    if (!seaDropCode || seaDropCode === "0x" || seaDropCode.length < 10) return null;
    const seaDrop = new ethers.Contract(SEADROP_V1_ADDRESS, SEADROP_V1_ABI, provider);
    let dropInfo;
    try { dropInfo = await seaDrop.getPublicDrop(contractAddress); } catch { return null; }
    const now = Math.floor(Date.now() / 1000);
    // FIX: return notStarted flag so caller can auto-schedule instead of giving up
    if (Number(dropInfo.startTime) > now) {
      return {
        success: false,
        notStarted: true,
        startTime: Number(dropInfo.startTime),
        error: `SeaDrop mint abhi shuru nahi hua.\nStart: ${new Date(Number(dropInfo.startTime) * 1000).toLocaleString()}`,
      };
    }
    if (Number(dropInfo.endTime) < now) return { success: false, error: "SeaDrop mint khatam ho gaya (sale ended)." };
    const mintPrice = dropInfo.mintPrice;
    const totalValue = mintPrice * BigInt(quantity);
    let feeRecipients = [];
    try { feeRecipients = await seaDrop.getAllowedFeeRecipients(contractAddress); } catch {}
    if (feeRecipients.length === 0) feeRecipients = [ethers.ZeroAddress, wallet.address];
    const seaDropWriter = new ethers.Contract(SEADROP_V1_ADDRESS, SEADROP_V1_ABI, wallet);
    const priorityFee = ethers.parseUnits(String(process.env.GAS_PRIORITY_FEE_GWEI || "5"), "gwei");
    for (const feeRecipient of feeRecipients) {
      try {
        const estimated = await seaDropWriter.mintPublic.estimateGas(contractAddress, feeRecipient, ethers.ZeroAddress, quantity, { value: totalValue });
        const gasLimit = BigInt(Math.ceil(Number(estimated) * gasMultiplier));
        const tx = await seaDropWriter.mintPublic(contractAddress, feeRecipient, ethers.ZeroAddress, quantity, { value: totalValue, gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: (feeData.maxFeePerGas || feeData.gasPrice) + priorityFee });
        return { success: true, txHash: tx.hash, quantity, priceEth: ethers.formatEther(totalValue), txUrl: txUrl(tx.hash), functionUsed: "SeaDrop.mintPublic", source: "seadrop-v1" };
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("insufficient funds") || msg.includes("exceeds balance")) return { success: false, error: "Wallet mein ETH kam hai gas ke liye." };
        continue;
      }
    }
    return { success: false, error: "SeaDrop mint revert hua. Wallet allowlist mein nahi hai ya mint paused hai." };
  } catch { return null; }
}
async function isSeaDropNFT(contractAddress, provider) {
  try {
    let targetAddr = contractAddress;
    const impl = await getImplementationAddress(contractAddress, provider);
    if (impl) targetAddr = impl;
    const bytecode = await provider.getCode(targetAddr);
    if (!bytecode || bytecode === "0x") return false;
    const hex = bytecode.slice(2);
    const sels = new Set();
    for (let i = 0; i < hex.length - 10; i += 2) { if (hex[i] === "6" && hex[i + 1] === "3") sels.add("0x" + hex.slice(i + 2, i + 10)); }
    let hits = 0;
    for (const sel of SEADROP_DETECT_SELECTORS) { if (sels.has(sel)) hits++; }
    return hits >= 2;
  } catch { return false; }
}
class NFTBuyer {
  constructor() {
    this._chains = {};
    this.gasMultiplier = Number(process.env.GAS_LIMIT_MULTIPLIER) || 1.3;
    this.priorityFeeGwei = Number(process.env.GAS_PRIORITY_FEE_GWEI) || 5;
    const ethProvider = new ethers.JsonRpcProvider(process.env.ETH_RPC_URL || "https://eth.llamarpc.com");
    this._defaultWallet = new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, ethProvider);
  }
  get address() { return this._defaultWallet.address; }
  _chain(chain = "ethereum") {
    const key = chain.toLowerCase();
    if (!this._chains[key]) {
      const cfg = getChainConfig(key);
      const provider = new ethers.JsonRpcProvider(cfg.rpc());
      this._chains[key] = { provider, wallet: new ethers.Wallet(process.env.WALLET_PRIVATE_KEY, provider), cfg };
    }
    return this._chains[key];
  }
  async getBalance(chain = "ethereum") {
    const { wallet } = this._chain(chain);
    return ethers.formatEther(await wallet.provider.getBalance(wallet.address));
  }
  async detectMintInfo(contractAddress, chain = "ethereum") {
    const { provider } = this._chain(chain);
    const contract = new ethers.Contract(contractAddress, READ_ABI, provider);
    const info = { mintPrice: 0n, isFree: true, isPaused: false };
    for (const fn of ["mintPrice", "price", "cost"]) {
      try { info.mintPrice = await contract[fn](); info.isFree = info.mintPrice === 0n; break; } catch {}
    }
    return info;
  }
  async _sendTx(contractInst, funcName, args, totalValue, feeData) {
    const priorityFee = ethers.parseUnits(String(this.priorityFeeGwei), "gwei");
    const estimated = await contractInst[funcName].estimateGas(...args, { value: totalValue });
    const gasLimit = BigInt(Math.ceil(Number(estimated) * this.gasMultiplier));
    return contractInst[funcName](...args, { value: totalValue, gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: (feeData.maxFeePerGas || feeData.gasPrice) + priorityFee });
  }
  async freeMint(contractAddress, quantity = 1, mintPriceWei = 0n, chain = "ethereum") {
    const { provider, wallet, cfg } = this._chain(chain);
    const feeData = await provider.getFeeData();
    const w = wallet.address;
    const txUrl = (hash) => `${cfg.explorer}/tx/${hash}`;
    const tryCall = async (contractInst, funcName, args, value = 0n) => {
      try {
        const tx = await this._sendTx(contractInst, funcName, args, value, feeData);
        return { success: true, txHash: tx.hash, quantity, priceEth: ethers.formatEther(value), txUrl: txUrl(tx.hash), functionUsed: funcName };
      } catch (err) {
        const msg = err.message || "";
        if (msg.includes("insufficient funds") || msg.includes("exceeds balance")) throw new Error("Wallet mein ETH kam hai gas ke liye.");
        return null;
      }
    };
    const isSeaDrop = await isSeaDropNFT(contractAddress, provider);
    if (isSeaDrop) {
      const sdResult = await trySeaDropV1Mint(contractAddress, quantity, wallet, feeData, this.gasMultiplier, txUrl);
      if (sdResult) return sdResult;
    }
    let abiAddress = contractAddress;
    const implAddr = await getImplementationAddress(contractAddress, provider);
    if (implAddr) abiAddress = implAddr;
    const [etherscanABI, sourcifyABI] = await Promise.all([fetchABIFromEtherscanV2(abiAddress, cfg.chainId), fetchABIFromSourceify(abiAddress, cfg.chainId)]);
    const verifiedABI = etherscanABI || sourcifyABI;
    if (verifiedABI) {
      const mintFuncs = findMintFunctionsFromABI(verifiedABI);
      for (const funcDef of mintFuncs) {
        try {
          const args = buildArgsFromABI(funcDef.inputs, quantity, w);
          if (args === null) continue;
          const inst = new ethers.Contract(contractAddress, verifiedABI, wallet);
          const totalValue = mintPriceWei * BigInt(quantity);
          const result = await tryCall(inst, funcDef.name, args, totalValue);
          if (result) return { ...result, source: "verified-abi" };
        } catch (err) { return { success: false, error: err.message }; }
      }
    }
    const { mintMatches, all: allSelectors } = await scanBytecodeSelectors(abiAddress !== contractAddress ? abiAddress : contractAddress, provider);
    const totalValue = mintPriceWei * BigInt(quantity);
    for (const info of mintMatches) {
      try {
        const inst = new ethers.Contract(contractAddress, [`function ${info.sig} external payable`], wallet);
        const result = await tryCall(inst, info.sig.split("(")[0], buildArgs(info.args, quantity, w), totalValue);
        if (result) return { ...result, source: "bytecode-scan" };
      } catch (err) { return { success: false, error: err.message }; }
    }
    const scannedSels = new Set(mintMatches.map((m) => m.selector));
    for (const info of KNOWN_MINT_SIGS) {
      const sel = ethers.id(info.sig).slice(0, 10);
      if (scannedSels.has(sel)) continue;
      try {
        const inst = new ethers.Contract(contractAddress, [`function ${info.sig} external payable`], wallet);
        const result = await tryCall(inst, info.sig.split("(")[0], buildArgs(info.args, quantity, w), totalValue);
        if (result) return { ...result, source: "blind-fallback" };
      } catch (err) { return { success: false, error: err.message }; }
    }
    const sampleSels = allSelectors.filter(s => s !== "0x00000000" && s !== "0xffffffff").slice(0, 6).join(", ");
    return { success: false, error: "Mint function detect nahi hua.\n\n" + (sampleSels ? `Contract selectors:\n<code>${sampleSels}</code>\n\n` : "") + "Possible reasons:\n• Sale abhi paused hai\n• Allowlist required hai\n• Custom protocol use ho raha hai" };
  }
  async buyListing(listing, chain = "ethereum") {
    try {
      const { provider, wallet, cfg } = this._chain(chain);
      const fulfillment = await getFulfillmentData(listing.orderId, wallet.address, chain);
      const txData = fulfillment?.fulfillment_data?.transaction;
      if (!txData) throw new Error("No transaction data from OpenSea");
      const feeData = await provider.getFeeData();
      const priorityFee = ethers.parseUnits(String(this.priorityFeeGwei), "gwei");
      const estimatedGas = await provider.estimateGas({ to: txData.to, data: txData.input_data, value: BigInt(listing.priceWei), from: wallet.address });
      const gasLimit = BigInt(Math.ceil(Number(estimatedGas) * this.gasMultiplier));
      const tx = await wallet.sendTransaction({ to: txData.to, data: txData.input_data, value: BigInt(listing.priceWei), gasLimit, maxPriorityFeePerGas: priorityFee, maxFeePerGas: (feeData.maxFeePerGas || feeData.gasPrice) + priorityFee });
      return { success: true, txHash: tx.hash, tokenId: listing.tokenId, priceEth: listing.priceEth, txUrl: `${cfg.explorer}/tx/${tx.hash}` };
    } catch (err) { return { success: false, error: err.message, tokenId: listing.tokenId }; }
  }
  async waitForTx(txHash, chain = "ethereum") {
    const { provider } = this._chain(chain);
    const receipt = await provider.waitForTransaction(txHash, 1, 60000);
    return receipt?.status === 1;
  }
}
module.exports = { NFTBuyer };
