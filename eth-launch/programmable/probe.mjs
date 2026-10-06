const rpcs = ["https://ethereum-rpc.publicnode.com","https://eth.llamarpc.com","https://eth.drpc.org","https://1rpc.io/eth","https://eth-mainnet.public.blastapi.io","https://rpc.mevblocker.io","https://eth.merkle.io","https://cloudflare-eth.com","https://rpc.flashbots.net","https://ethereum.blockpi.network/v1/rpc/public","https://eth.blockrazor.xyz","https://gateway.tenderly.co/public/mainnet"];
const body = (from,to) => JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_getLogs", params:[{ address:"0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887", fromBlock:"0x"+from.toString(16), toBlock:"0x"+to.toString(16), topics:[] }] });
for (const u of rpcs) {
  try {
    const r = await fetch(u, { method:"POST", headers:{"content-type":"application/json"}, body: body(26125550, 26129200), signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let n = "?"; try { const j = JSON.parse(t); n = j.result ? j.result.length + " logs" : JSON.stringify(j.error).slice(0,160); } catch { n = t.slice(0,120); }
    console.log(u, r.status, n);
  } catch (e) { console.log(u, "ERR", e.message.slice(0,80)); }
}
