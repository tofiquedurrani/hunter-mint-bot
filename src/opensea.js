// src/opensea.js
// OpenSea API v2 integration

const axios = require("axios");

const BASE_URL = "https://api.opensea.io/api/v2";

const headers = () => ({
  "x-api-key": process.env.OPENSEA_API_KEY,
  accept: "application/json",
});

/**
 * Parse OpenSea URL and extract collection slug
 */
function parseCollectionUrl(url) {
  try {
    const u = new URL(url.trim());
    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("collection");
    if (idx !== -1 && parts[idx + 1]) {
      return parts[idx + 1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get collection info including contract address for free mint
 */
async function getCollection(slug) {
  try {
    const { data } = await axios.get(`${BASE_URL}/collections/${slug}`, {
      headers: headers(),
      timeout: 10000,
    });

    // Get contract address from multiple possible locations
    const contractAddress =
      data.contracts?.[0]?.address ||
      data.primary_asset_contracts?.[0]?.address ||
      null;

    const contractChain =
      data.contracts?.[0]?.chain ||
      data.payment_tokens?.[0]?.chain ||
      "ethereum";

    const floorPrice =
      data.stats?.floor_price ||
      data.collection?.stats?.floor_price ||
      null;

    return {
      slug,
      name: data.name || slug,
      chain: contractChain.toLowerCase(),
      floorPrice,
      totalSupply: data.stats?.total_supply,
      numOwners: data.stats?.num_owners,
      contractAddress,
    };
  } catch (err) {
    throw new Error(
      `Collection fetch failed: ${err.response?.data?.errors || err.message}`
    );
  }
}

/**
 * Get cheapest active listings for a collection below maxPriceEth
 */
async function getCheapestListings(slug, maxPriceEth, limit = 10) {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/listings/collection/${slug}/best`,
      {
        headers: headers(),
        params: { limit: Math.min(limit, 100) },
        timeout: 8000,
      }
    );

    const listings = (data.listings || [])
      .map((l) => {
        const priceWei =
          l.price?.current?.value ||
          l.current_price ||
          l.protocol_data?.parameters?.offer?.[0]?.startAmount;

        const priceEth = priceWei
          ? Number(BigInt(priceWei)) / 1e18
          : null;

        return {
          orderId: l.order_hash,
          tokenId:
            l.protocol_data?.parameters?.offer?.[0]?.identifierOrCriteria,
          priceEth,
          priceWei,
          seller: l.protocol_data?.parameters?.offerer,
          expiresAt: l.closing_date,
          protocolData: l.protocol_data,
          orderType: l.order_type,
        };
      })
      .filter((l) => l.priceEth !== null && l.priceEth <= maxPriceEth)
      .sort((a, b) => a.priceEth - b.priceEth);

    return listings;
  } catch (err) {
    throw new Error(
      `Listings fetch failed: ${err.response?.data?.errors || err.message}`
    );
  }
}

/**
 * Get fulfillment data for a specific listing (needed to execute buy)
 */
async function getFulfillmentData(orderHash, buyerAddress, chain = "ethereum") {
  try {
    const { data } = await axios.post(
      `${BASE_URL}/offers/fulfillment_data`,
      {
        order: {
          hash: orderHash,
          chain,
          protocol_address: getSeaportAddress(chain),
        },
        fulfiller: { address: buyerAddress },
      },
      {
        headers: { ...headers(), "Content-Type": "application/json" },
        timeout: 10000,
      }
    );
    return data;
  } catch (err) {
    throw new Error(
      `Fulfillment data failed: ${err.response?.data?.errors || err.message}`
    );
  }
}

function getSeaportAddress(chain) {
  const addresses = {
    ethereum: "0x0000000000000068F116a894984e2DB1123eB395",
    polygon: "0x0000000000000068F116a894984e2DB1123eB395",
    base: "0x0000000000000068F116a894984e2DB1123eB395",
  };
  return addresses[chain] || addresses.ethereum;
}

module.exports = {
  parseCollectionUrl,
  getCollection,
  getCheapestListings,
  getFulfillmentData,
  getSeaportAddress,
};
