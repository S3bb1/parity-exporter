#!/usr/bin/env node
const request = require('request-promise-native')
const polka = require('polka')
const yargs = require('yargs')
const winston = require('winston')
const { Registry, Gauge } = require('prom-client')
const { hashObject } = require('prom-client/lib/util')

const logger = winston.createLogger({
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()]
})

function getArgs () {
  return yargs
    .usage('Usage: $0 [options]')
    .env('PARITY_EXPORTER')
    .option('interval', {
      default: 100,
      describe: 'Metrics fetch interval',
      type: 'number'
    })
    .option('listen', {
      coerce (arg) {
        const [hostname, port] = arg.split(':')
        return { hostname, port }
      },
      default: 'localhost:8000',
      describe: 'Provide metrics on host:port/metrics',
      type: 'string'
    })
    .option('nodes', {
      describe: 'Fetch info from this nodes',
      type: 'array'
    })
    .version()
    .help('help').alias('help', 'h')
    .argv
}

async function makeRequest (url, method, params = []) {
  const res = await request({
    url: url,
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      method,
      params,
      id: 42
    }),
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    },
    rejectUnauthorized:false
  })

  const json = JSON.parse(res)
  if (json.error) throw new Error(`RPC error for ${url} (code: ${json.error.code}): ${json.error.message}`)

  return json.result
}

function initParityMetrics (registry, nodeURL, gauges) {

  const data = {
    version: '',
    chain: '',
    latest: '',
    gasPrice: 0,
    peers: new Map([['all', 0]])
  }

  return async () => {

    const start = new Date().getTime();
    const clientVersion = await makeRequest(nodeURL, 'web3_clientVersion');
    const elapsed = new Date().getTime() - start;
    gauges.responseTime.set({ instance: nodeURL }, elapsed)
    gauges.up.set({ instance: nodeURL }, 1)

    const [
      clientChain,
      latestBlock,
      syncInfo,
      mempool,
      peersInfo
    ] = await Promise.all([
      makeRequest(nodeURL, 'parity_chain'),
      makeRequest(nodeURL, 'eth_getBlockByNumber', ['latest', false]),
      makeRequest(nodeURL, 'eth_syncing'),
      makeRequest(nodeURL, 'parity_allTransactions'),
      makeRequest(nodeURL, 'parity_netPeers')
    ])

    // version
    if (data.version !== clientVersion) {
      gauges.version.set({ value: clientVersion, instance: nodeURL }, 1)
      data.version = clientVersion
      logger.info(`update version to ${clientVersion}`)
    }

    // chain
    if (data.chain !== clientChain) {
      gauges.chain.set({ value: clientChain, instance: nodeURL }, 1)
      data.chain = clientChain
      logger.info(`update chain to ${clientChain}`)
    }

    // latest
    if (data.latest !== latestBlock.hash) {
      const [hash, number] = [latestBlock.hash, parseInt(latestBlock.number, 16)]
      if (data.latest) delete gauges.latest.hash.hashMap[hashObject({ hash: data.latest })]
      gauges.latest.hash.set({ hash, instance: nodeURL }, number)
      data.latest = hash
      logger.info(`update latest to ${number} - ${hash}`)

      const [current, highest] = syncInfo
        ? [parseInt(syncInfo.currentBlock, 16), parseInt(syncInfo.highestBlock, 16)]
        : [number, number]

      gauges.latest.sync.set({ type: 'current', instance: nodeURL }, current)
      gauges.latest.sync.set({ type: 'highest', instance: nodeURL }, highest)
      gauges.latest.sync.set({ type: 'progress', instance: nodeURL }, parseFloat((current / highest).toFixed(5)))
    }


    // mempool
    gauges.mempool.set({ type: 'size', instance: nodeURL }, mempool.length)
    gauges.mempool.set({ type: 'bytes', instance: nodeURL }, mempool.reduce((total, tx) => total + tx.raw.length - 2, 0))

    // peers
    // const peers = peersInfo.peers.filter((peer) => peer.network.remoteAddress !== 'Handshake')
    // for (const key of data.peers.keys()) data.peers.set(key, 0)
    // data.peers.set('all', peers.length)
    // for (const peer of peers) data.peers.set(peer.name, (data.peers.get(peer.name) || 0) + 1)
    // for (const [version, value] of data.peers.entries()) {
    //   if (value === 0) delete gauges.peers.hashMap[hashObject({ version })]
    //   else gauges.peers.set({ version }, value)
    // }
    gauges.peers.set({ version: 'all', instance: nodeURL }, peersInfo.connected)
  }
}

function createPrometheusClient (register, node, gauges) {
  return {
    update: initParityMetrics(register, node, gauges)
  }
}

async function main () {
  const args = getArgs()
  const promClients = []
  const register = new Registry()
  const createGauge = (name, help, labelNames) => new Gauge({ name, help, labelNames, registers: [register] })

  function onRequest (req, res) {
    res.setHeader('Content-Type', register.contentType)
    res.end(register.metrics())
  }

  const gauges = {
    version: createGauge('parity_version', 'Client version', ['value', 'instance']),
    chain: createGauge('parity_chain', 'Client chain', ['value', 'instance']),
    responseTime: createGauge('parity_responseTime', 'Response time', ['instance']),
    up: createGauge('partiy_up', 'Is service up?', ['instance']),
    latest: {
      hash: createGauge('parity_latest', 'Latest block information', ['hash', 'instance']),
      sync: createGauge('bitcoind_blockchain_sync', 'Blockchain sync info', ['type', 'instance'])
    },
    mempool: createGauge('parity_mempool_size', 'Mempool information', ['type', 'instance']),
    peers: createGauge('parity_peers', 'Connected peers', ['version', 'instance'])
  }
  for(let node of args.nodes) {
    promClients.push(createPrometheusClient(register, node, gauges))
  }
  await polka().get('/metrics', onRequest).listen(args.listen)
  logger.info(`listen at ${args.listen.hostname}:${args.listen.port}`)

  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  while (true) {
    const ts = Date.now()
    await Promise.all(promClients.map((client) => client.update()))
    const delay = Math.max(10, args.interval - (Date.now() - ts))
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}

main().catch((err) => {
  logger.error(String(err.stack || err))
  process.exit(1)
})
