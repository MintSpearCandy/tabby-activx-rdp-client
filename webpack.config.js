const path = require('path')

module.exports = {
  target: 'node',
  entry: 'src/index.ts',
  devtool: 'source-map',
  context: __dirname,
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    pathinfo: true,
    libraryTarget: 'umd',
    devtoolModuleFilenameTemplate: 'webpack-tabby-activx-rdp:///[resource-path]',
  },
  resolve: {
    modules: ['.', 'src', 'node_modules'].map(x => path.join(__dirname, x)),
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'awesome-typescript-loader',
        options: {
          configFileName: path.resolve(__dirname, 'tsconfig.json'),
          // Type checking is done separately via `tsc --noEmit`;
          // ATL's checker subprocess is incompatible with TS >= 4.5
          transpileOnly: true,
        }
      },
      {
        // Component styles (Angular `styles: [...]`) need the CSS as a
        // string; style-loader would export css-loader's array format and
        // crash Angular's JIT style compiler ("input.match is not a function")
        test: /\.scss$/,
        use: ['@tabby-gang/to-string-loader', 'css-loader', 'sass-loader'],
        include: /component\.scss$/,
      },
      {
        test: /\.scss$/,
        use: ['style-loader', 'css-loader', 'sass-loader'],
        exclude: /component\.scss$/,
      },
      { test: /\.pug$/, use: ['apply-loader', 'pug-loader'] },
    ]
  },
  externals: [
    'fs',
    // Resolved from the Tabby host at runtime (Tabby bundles @electron/remote);
    // only the typings are used at compile time
    '@electron/remote',
    /^rxjs/,
    /^@angular/,
    /^@ng-bootstrap/,
    /^tabby-/,
  ]
}
