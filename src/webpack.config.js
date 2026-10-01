const path = require('path')
const webpack = require('webpack')
const HtmlWebpackPlugin = require('html-webpack-plugin')

module.exports = {
  mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  entry: path.resolve(__dirname, 'index.js'),
  output: {
    path: path.resolve(__dirname, '..', 'dist'),
    filename: 'main.js',
    publicPath: ''
  },
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: { loader: 'babel-loader' }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({ template: path.resolve(__dirname, 'index.html') }),
    new webpack.DefinePlugin({
      'process.env.AIO_RUNTIME_NAMESPACE':
        JSON.stringify(process.env.AIO_RUNTIME_NAMESPACE || '')
    })
  ],
  resolve: { extensions: ['.js', '.jsx'] },
  devServer: { historyApiFallback: true, hot: true }
}