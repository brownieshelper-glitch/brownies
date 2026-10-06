/* Site configuration. The contract addresses are NOT here: they come from deployments/1.json, which the deploy
   script writes. The gateway address is set here once the gateway has its https address. */
window.BROWNIES_CONFIG = {
  chainId: 1,
  chainName: "Ethereum",
  rpc: "https://ethereum-rpc.publicnode.com",
  explorer: "https://etherscan.io",
  // the https address of the gateway, for example https://api.feedthebrownies.com (no trailing slash). Empty until it exists.
  gateway: "https://api.feedthebrownies.com",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  programmable: "https://programmable.market/token/",
  gmgn: "https://gmgn.ai/eth/token/",
};
