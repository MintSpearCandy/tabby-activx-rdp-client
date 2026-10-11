// scripts/build-native.js — build the N-API addon (rdp_host.node) into
// native/. The addon is N-API (ABI-stable), so the headers target only
// affects which runtime validates first; defaults to plain Node headers,
// --electron <version> builds against Electron headers instead.
//
// Usage: node scripts/build-native.js [--electron 44.6.0]
const { spawnSync } = require('child_process')
const path = require('path')

const root = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const eIdx = argv.indexOf('--electron')
const electronVer = eIdx >= 0 ? argv[eIdx + 1] : null

const args = [
  path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js'),
  'rebuild',
  '--arch=x64',
  '--msvs_version=2022',
]
if (electronVer) {
  args.push('--target=' + electronVer, '--dist-url=https://electronjs.org/headers')
}

console.log('[build-native] target:', electronVer ? `electron ${electronVer}` : `node ${process.version}`)
const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root })
if (r.status !== 0) {
    process.exit(r.status === null ? 1 : r.status)
}
const fs = require('fs')
fs.copyFileSync(path.join(root, 'build', 'Release', 'rdp_host.node'),
                path.join(root, 'native', 'rdp_host.node'))
console.log('[build-native] rdp_host.node copied into native/')
