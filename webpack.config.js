const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
    entry: './src/ui/App.jsx',
    target: 'electron-renderer',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'bundle.js',
    },
    module: {
        rules: [
            {
                test: /\.jsx?$/,
                exclude: /node_modules/,
                type: 'javascript/auto',
                use: {
                    loader: 'babel-loader',
                    options: {
                        sourceType: 'unambiguous',
                        presets: ['@babel/preset-react']
                    }
                }
            },
            {
                test: /\.css$/,
                use: [
                    'style-loader',
                    'css-loader',
                    'postcss-loader' // Add this line
                ]
            },
            {
                test: /\.(png|jpe?g|gif|svg|webp|ico)$/i,
                type: 'asset/resource'
            }
        ]
    },
    plugins: [
        new HtmlWebpackPlugin({
            template: './src/ui/index.html'
        })
    ],
    resolve: {
        extensions: ['.js', '.jsx'],
        // Force CJS build: ESM re-exports break `require('i18next')` (namespace has no `.on`, only `default` does)
        alias: {
            i18next: path.resolve(__dirname, 'node_modules/i18next/dist/cjs/i18next.js'),
        },
    },
    optimization: {
        moduleIds: 'deterministic',
    },
};
