// src/monitor.js
// Real-time listing monitor - polls OpenSea every N seconds

const { getCheapestListings } = require("./opensea");

class CollectionMonitor {
  constructor({ slug, maxPriceEth, quantity, chain, onFound, onTick }) {
    this.slug = slug;
    this.maxPriceEth = maxPriceEth;
    this.quantity = quantity;
    this.chain = chain;
    this.onFound = onFound;
    this.onTick = onTick;
    this.running = false;
    this.timer = null;
    this.pollCount = 0;
    this.seenOrders = new Set();
    this.bought = 0;
  }

  start() {
    this.running = true;
    this._poll();
    this.timer = setInterval(
      () => this._poll(),
      Number(process.env.POLL_INTERVAL_MS) || 2000
    );
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  async _poll() {
    if (!this.running) return;
    this.pollCount++;

    try {
      const listings = await getCheapestListings(
        this.slug,
        this.maxPriceEth,
        this.quantity + 5
      );

      const fresh = listings.filter((l) => !this.seenOrders.has(l.orderId));

      if (fresh.length > 0 && this.onFound) {
        const toProcess = fresh.slice(0, this.quantity - this.bought);
        toProcess.forEach((l) => this.seenOrders.add(l.orderId));
        await this.onFound(toProcess);
        this.bought += toProcess.length;
      }

      if (this.onTick) {
        this.onTick({
          pollCount: this.pollCount,
          listingsFound: listings.length,
          cheapest: listings[0]?.priceEth ?? null,
          bought: this.bought,
        });
      }

      if (this.bought >= this.quantity) {
        this.stop();
      }
    } catch (_err) {
      // Silent fail - keep polling
    }
  }
}

module.exports = { CollectionMonitor };
