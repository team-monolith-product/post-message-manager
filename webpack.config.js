const path = require("path");

module.exports = {
  mode: "production",
  entry: "./src/index.ts", // 번들링 시작점
  output: {
    filename: "bundle.js", // 최종 결과물 파일
    path: path.resolve(__dirname, "dist"),
    library: {
      type: "global",
    },
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  module: {
    rules: [
      {
        test: /\.ts$/, // .ts 파일을
        use: "ts-loader", // ts-loader로 변환
        exclude: /node_modules/,
      },
    ],
  },
};
