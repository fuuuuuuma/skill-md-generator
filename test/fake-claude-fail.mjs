#!/usr/bin/env node
// 異常終了する偽の実行体。エラーの伝わり方を試すために使う。
process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('Invalid API key\n');
  process.exit(1);
});
