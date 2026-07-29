// tests/test-toolcall-parser.js
// Unit test for parseToolcallContent - verifies 6 toolcall parsing formats
const { parseToolcallContent } = require('../src/anthropic-format');

const testCases = [
  // Format 1: Direct JSON
  {
    name: 'F1-direct-json',
    input: '{"name":"Read","params":{"path":"a.txt"}}',
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 2: XML named
  {
    name: 'F2-xml-named',
    input: '<toolcall name="Read"><param name="path">a.txt</param></toolcall>',
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 3: XML arg_key/arg_value
  {
    name: 'F3-xml-argkey',
    input: 'Read <arg_key>path</arg_key><arg_value>a.txt</arg_value>',
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 4: XML attribute
  {
    name: 'F4-xml-attr',
    input: 'Read path="a.txt"',
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 5: JSON fixup (single quotes, trailing comma)
  {
    name: 'F5-json-fixup',
    input: "{'name':'Read','params':{'path':'a.txt',}}",
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 6: JSON extract from mixed content
  {
    name: 'F6-json-extract',
    input: 'Let me read that {"name":"Read","params":{"path":"a.txt"}} for you',
    expect: { name: 'Read', params: { path: 'a.txt' } }
  },
  // Format 7: Lenient extraction — unescaped quotes inside string values
  // Model generates: node -e "code" where inner " are not escaped as \"
  {
    name: 'F7-lenient-unescaped-quotes',
    input: '{"name":"bash","params":{"command":"node -e "const fs=require(\'fs\');console.log(1)""}}',
    expect: { name: 'bash', params: { command: 'node -e "const fs=require(\'fs\');console.log(1)"' } }
  },
  // Format 8: Lenient extraction — multiple params with unescaped quotes
  {
    name: 'F8-lenient-multiple-params',
    input: '{"name":"edit","params":{"filePath":"src/server.js","oldString":"const x = "hello"","newString":"const x = "world""}}',
    expect: { name: 'edit', params: { filePath: 'src/server.js', oldString: 'const x = "hello"', newString: 'const x = "world"' } }
  },
  // Format 9: Lenient extraction — no params wrapper, flat fields
  {
    name: 'F9-lenient-flat-fields',
    input: '{"name":"bash","command":"echo "hello world""}',
    expect: { name: 'bash', params: { command: 'echo "hello world"' } }
  },
  // Format 10: Function-call syntax — funcName({"key":"value"})
  // 模型生成 <tool_call>glob({"path":"...","pattern":"..."})</arg_value>
  {
    name: 'F10-func-call-json',
    input: 'glob({"path":"C:\\\\Codes\\\\unapk\\\\projects\\\\rcs","pattern":"jadx_go_out"})',
    expect: { name: 'glob', params: { path: 'C:\\Codes\\unapk\\projects\\rcs', pattern: 'jadx_go_out' } }
  },
  // Format 11: Function-call syntax — funcName(key="value", key2="value2")
  {
    name: 'F11-func-call-kv',
    input: 'glob(path="C:\\\\Codes\\\\unapk\\\\projects\\\\rcs", pattern="jadx_go_out")',
    expect: { name: 'glob', params: { path: 'C:\\\\Codes\\\\unapk\\\\projects\\\\rcs', pattern: 'jadx_go_out' } }
  },
  // Format 12: Function-call 混合位置参数和命名参数
  // 模型生成 read(CONTENT..., C:/path/file.py, offset=30, limit=30)
  // CONTENT... 占位符被跳过，位置参数按 read 工具签名映射到 file_path
  {
    name: 'F12-func-call-mixed',
    input: 'read(CONTENT..., C:/Codes/unapk/projects/rcs/run_register_capture.py, offset=30, limit=30)',
    expect: { name: 'read', params: { offset: '30', limit: '30', file_path: 'C:/Codes/unapk/projects/rcs/run_register_capture.py' } }
  },
  // Format 13: Function-call with CONTENT... placeholder + bash command
  // 模型生成 bash<tool_call>name(CONTENT..., adb -s ... "...")
  // parseToolcallContent 直接解析时 name 字面是 "name"，不在 POS_KEY_MAP
  // CONTENT... 被跳过，adb... 作为 arg0
  // tryParseInner 会用 pendingToolName 把 "name" 替换为 "bash"
  {
    name: 'F13-func-call-bash-content',
    input: 'name(CONTENT..., adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | head -5")',
    expect: { name: 'name', params: { arg0: 'adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | head -5"' } }
  },
  // Format 14: 嵌套 <arg_key> 标签的函数调用
  // 模型生成 <tool_call>bash<arg_key>name(CONTENT..., adb ... "...")
  // inner = bash<arg_key>name(CONTENT..., ...)
  // parseFunctionCallToolcall 剥离 bash<arg_key> 前缀，name 字面 "name" 替换为 "bash"
  {
    name: 'F14-func-call-nested-argkey',
    input: 'bash<arg_key>name(CONTENT..., adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | grep versionName; dumpsys package com.google.android.apps.messaging | grep versionCode")',
    expect: { name: 'bash', params: { command: 'adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | grep versionName; dumpsys package com.google.android.apps.messaging | grep versionCode"' } }
  },
  // Format 15: XML arg_key/arg_value 参数格式
  // 模型生成 <tool_call>bash<arg_key>command</arg_key><arg_value>adb -s ...</arg_value>
  // feed() 在 </arg_value> 处闭合，inner = bash<arg_key>command</arg_key><arg_value>adb -s ...
  {
    name: 'F15-xml-argkey-argvalue',
    input: 'bash<arg_key>command</arg_key><arg_value>adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | head -5"',
    expect: { name: 'bash', params: { command: 'adb -s 192.17.19.1:5566 shell "dumpsys package com.google.android.apps.messaging | head -5"' } }
  },
  // Format 16: XML arg_key 参数格式，标签混用（<tool_call> 作为参数 key 开标签）
  // 模型生成 ...</arg_value><tool_call>timeout</arg_key>15000
  // feed() 把 <tool_call> 当新 toolcall 开标签，inner = timeout</arg_key>15000
  // parseXmlArgKeyToolcall 误解析为 {name:'timeout', params:{timeout:'15000'}}
  // 虽不完美（timeout 不是工具名），但至少不作为文本输出
  {
    name: 'F16-xml-argkey-mixed-tag',
    input: 'timeout</arg_key>15000',
    expect: { name: 'timeout', params: { timeout: '15000' } }
  },
  // Format 17: funcName({...}} — model forgot closing ) and used } instead
  {
    name: 'F17-func-call-missing-paren',
    input: 'write({"content":"print(\'hello\')","filePath":"test.py"}}',
    expect: { name: 'write', params: { content: "print('hello')", filePath: 'test.py' } }
  },
  // Format 18: funcName({...} — model forgot closing ) entirely
  {
    name: 'F18-func-call-no-closing-paren',
    input: 'write({"content":"hello world","filePath":"a.txt"}',
    expect: { name: 'write', params: { content: 'hello world', filePath: 'a.txt' } }
  },
  // Format 19: 双重标签 — 模型输出 <tool_call>toolcall>{...}</toolcall>
  // 流过滤器匹配外层后 inner 残留 "toolcall>{...}"，需剥离前缀
  {
    name: 'F19-double-tag-prefix',
    input: 'toolcall>{"name":"bash","params":{"command":"Get-ChildItem -Path C:\\\\Codes\\\\test","workdir":"C:\\\\Codes"}}',
    expect: { name: 'bash', params: { command: 'Get-ChildItem -Path C:\\Codes\\test', workdir: 'C:\\Codes' } }
  },
  // Format 20: 双重标签 tool_call> 变体
  {
    name: 'F20-double-tag-prefix-underscore',
    input: 'tool_call>{"name":"read","params":{"file_path":"a.txt"}}',
    expect: { name: 'read', params: { file_path: 'a.txt' } }
  },
  // Format 21: JSON 缺少闭合 }} — 模型截断时漏掉
  {
    name: 'F21-missing-close-braces',
    input: '{"name":"bash","params":{"command":"adb shell \'su -c \\"sed -i s/old/new/g file\\"\'"',
    expect: { name: 'bash', params: { command: 'adb shell \'su -c "sed -i s/old/new/g file"\'' } }
  },
];

console.log('=== Toolcall Parser Unit Test ===\n');
let pass = 0, fail = 0;
for (const tc of testCases) {
  try {
    const result = parseToolcallContent(tc.input);
    const ok = result &&
      result.name === tc.expect.name &&
      JSON.stringify(result.params) === JSON.stringify(tc.expect.params);
    if (ok) {
      console.log(`  PASS: ${tc.name}`);
      pass++;
    } else {
      console.log(`  FAIL: ${tc.name}`);
      console.log(`    expected: ${JSON.stringify(tc.expect)}`);
      console.log(`    got:      ${JSON.stringify(result)}`);
      fail++;
    }
  } catch(e) {
    console.log(`  FAIL: ${tc.name} - ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass}/${testCases.length} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
