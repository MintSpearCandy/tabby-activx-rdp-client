// deploy.js — copy the built plugin into an isolated Tabby instance's
// user-plugins directory. Node fs only (bash cp with quoted Windows paths
// has created malformed directory names before — tabby-debug skill rule).
//
// Usage: node scripts/deploy.js [instanceDir]
//   instanceDir defaults to D:\Env\TabbyEnv\instances\arc
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const target = path.resolve(process.argv[2] || 'D:\\Env\\TabbyEnv\\instances\\arc')
const dest = path.join(target, 'data', 'plugins', 'node_modules', 'tabby-activx-rdp-client')

if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
    console.error('dist/index.js missing — run `npm run build` first')
    process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(dest, { recursive: true })

for (const item of ['dist', 'native', 'package.json', 'README.md']) {
    const src = path.join(root, item)
    if (!fs.existsSync(src)) {
        console.warn(`skip (missing): ${item}`)
        continue
    }
    const dst = path.join(dest, item)
    const st = fs.statSync(src)
    if (st.isDirectory()) {
        fs.cpSync(src, dst, { recursive: true })
    } else {
        fs.copyFileSync(src, dst)
    }
    console.log(`copied ${item}`)
}
console.log(`\ndeployed to ${dest}`)
console.log('restart the instance to load it (Page.reload does NOT reload user plugins)')
