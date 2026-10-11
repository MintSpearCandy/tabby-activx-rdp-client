// setupTestProfile.js — write a saved RDP profile + Ctrl-F9 profile hotkey
// into the arc instance's config.yaml (Tabby reads config only at startup).
// Usage: node scripts/setupTestProfile.js [instanceDir] [host]
const fs = require('fs')
const path = require('path')

const instanceDir = process.argv[2] || 'D:\\Env\\TabbyEnv\\instances\\arc'
const host = process.argv[3] || '172.24.242.124'
const cfgPath = path.join(instanceDir, 'data', 'config.yaml')

let cfg = fs.readFileSync(cfgPath, 'utf8')

// Replace the profiles line (fresh instance has "profiles: []").
if (/^profiles: \[\]\s*$/m.test(cfg)) {
    cfg = cfg.replace(/^profiles: \[\]\s*$/m, [
        `profiles:`,
        `  - id: activx-rdp-test`,
        `    type: activx-rdp`,
        `    name: RDP Test (WSL)`,
        `    options:`,
        `      host: ${host}`,
        `      port: 3389`,
        `      username: mscandy`,
        `      password: rdppoc123`,
        `      domain: ''`,
        `      width: 0`,
        `      height: 0`,
    ].join('\n'))
} else {
    console.error('profiles section not empty — edit config.yaml by hand')
    process.exit(1)
}

// Add hotkeys.profile binding under the existing hotkeys: key.
if (/^hotkeys:\s*$/m.test(cfg)) {
    cfg = cfg.replace(/^hotkeys:\s*$/m, [
        `hotkeys:`,
        `  profile:`,
        `    activx-rdp-test: [Ctrl-F9]`,
    ].join('\n'))
} else {
    console.error('no hotkeys: section found')
    process.exit(1)
}

fs.writeFileSync(cfgPath, cfg)
console.log(`config written: profile activx-rdp-test -> ${host}:3389, hotkey Ctrl-F9`)
