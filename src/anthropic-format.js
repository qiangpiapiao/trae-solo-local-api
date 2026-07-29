const { v4: uuidv4 } = require('./uuid');

// Extract the first balanced JSON object from a string using brace-matching.
// Properly handles braces inside string values (e.g. "}" inside a string won't count).
// Returns the substring of the first complete {...}, or null if not found.
function extractFirstJsonObject(str) {
  const start = str.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.substring(start, i + 1);
    }
  }
  return null;
}

// Parse function-call-style toolcall: funcName({"key":"value","key2":"value2"})
// 也支持 funcName(key="value", key2="value2") 和混合位置参数 funcName(arg1, arg2, key="val")
// 模型有时生成 <tool_call>glob({"path":"...","pattern":"..."})</arg_value> 这类非标准格式
// 也处理模型输出 write({...}} 缺少 ) 的情况
function parseFunctionCallToolcall(inner) {
  let trimmed = inner.trim();
  if (!trimmed) return null;

  // 通用预处理：在 funcName( 之前可能嵌套 <arg_key> 等标签
  let candidateToolName = null;
  const funcStart = trimmed.search(/[A-Za-z_][\w\-\.]*\s*\(/);
  if (funcStart > 0) {
    const prefix = trimmed.slice(0, funcStart);
    const tagMatch = prefix.match(/([A-Za-z_][\w\-\.]*)\s*<[a-z_][\w\-]*>/i);
    if (tagMatch) {
      candidateToolName = tagMatch[1];
      trimmed = trimmed.slice(funcStart);
    }
  } else if (funcStart < 0) {
    const cleaned = trimmed.replace(/([A-Za-z_][\w\-\.]*)?\s*<[a-z_][\w\-]*>/gi, (match, ident) => {
      if (ident && !candidateToolName) candidateToolName = ident;
      return '';
    }).trim();
    if (cleaned !== trimmed) {
      trimmed = cleaned;
    }
  }

  // 尝试匹配 funcName(...) — 严格要求首尾配对
  let m = trimmed.match(/^([A-Za-z_][\w\-\.]*)\s*\(([\s\S]*)\)\s*$/);
  if (!m) {
    // 松散匹配：funcName({...}  (缺少 ) — 模型常把 ) 写成 } 或遗漏)
    const loose = trimmed.match(/^([A-Za-z_][\w\-\.]*)\s*\(([\s\S]*)$/);
    if (loose) {
      m = loose;
    } else {
      // 最后尝试：从文本中提取 funcName(...) 模式
      const fallback = trimmed.match(/([A-Za-z_][\w\-\.]*)\s*\(([\s\S]*)\)\s*$/);
      if (fallback) {
        m = fallback;
      } else {
        return null;
      }
    }
  }
  let name = m[1];
  let argsRaw = m[2].trim();
  // 松散匹配时 argsRaw 可能有多余的尾部 } 或 )，用 brace-matching 提取完整 JSON
  if (!argsRaw) return { name, params: {} };

  // 若 name 字面是 "name" 且有候选工具名，用候选工具名替换
  if (name === 'name' && candidateToolName) {
    name = candidateToolName;
  }

  // 1) 尝试 JSON 解析
  if (argsRaw.startsWith('{')) {
    // 1a) 直接 JSON.parse
    try {
      const params = JSON.parse(argsRaw);
      if (params && typeof params === 'object' && !Array.isArray(params)) {
        return { name, params };
      }
    } catch (e) {
      // JSON 解析失败，继续尝试其他方式
    }
    // 1b) 用 brace-matching 提取第一个完整 JSON 对象（处理 argsRaw 尾部多余的 } 或 ) ）
    const jsonObj = extractFirstJsonObject(argsRaw);
    if (jsonObj && jsonObj !== argsRaw) {
      try {
        const params = JSON.parse(jsonObj);
        if (params && typeof params === 'object' && !Array.isArray(params)) {
          return { name, params };
        }
      } catch (e) {}
    }
    // 1c) 尝试 lenient 提取（处理未转义引号）
    const lenientResult = lenientExtractToolcall('{"name":"' + name + '","params":' + (jsonObj || argsRaw) + '}');
    if (lenientResult && lenientResult.params && Object.keys(lenientResult.params).length > 0) {
      return { name, params: lenientResult.params };
    }
  }

  // 2) 按逗号分割参数，区分位置参数和命名参数
  //    用状态机分割，正确处理引号内的逗号
  const params = {};
  const positional = [];
  const argParts = [];
  let cur = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < argsRaw.length; i++) {
    const c = argsRaw[i];
    if (inQuote) {
      cur += c;
      if (c === quoteChar) {
        inQuote = false;
      }
    } else if (c === '"' || c === "'") {
      inQuote = true;
      quoteChar = c;
      cur += c;
    } else if (c === ',') {
      argParts.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) argParts.push(cur.trim());

  let namedCount = 0;
  for (const part of argParts) {
    // 命名参数：key="value" / key='value' / key=value（数字/布尔）
    const kvMatch = part.match(/^(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,]*))$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const val = kvMatch[2] != null ? kvMatch[2]
        : (kvMatch[3] != null ? kvMatch[3]
          : (kvMatch[4] != null ? kvMatch[4].trim() : ''));
      params[key] = val;
      namedCount++;
    } else {
      // 位置参数：只去掉配对的外层引号
      let stripped = part;
      if (stripped.length >= 2) {
        const first = stripped[0];
        const last = stripped[stripped.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          stripped = stripped.slice(1, -1);
        }
      }
      positional.push(stripped);
    }
  }

  // 3) 如果有命名参数，优先返回命名参数（位置参数作为 arg0/arg1 补充）
  if (namedCount > 0 || positional.length > 0) {
    // 常见工具的位置参数→key 映射（按工具名）
    // 模型生成 read(CONTENT..., /path, offset=30) 时，位置参数应映射到 file_path
    // 模型生成 bash(CONTENT..., adb ...) 时，位置参数应映射到 command
    const POS_KEY_MAP = {
      bash: ['command'],
      sh: ['command'],
      shell: ['command'],
      exec: ['command'],
      run: ['command'],
      read: ['file_path', 'offset', 'limit'],
      write: ['file_path', 'content'],
      edit: ['file_path', 'old_string', 'new_string'],
      glob: ['path', 'pattern'],
      grep: ['pattern', 'path'],
      list: ['path']
    };
    const posKeys = POS_KEY_MAP[name.toLowerCase()] || [];
    let posIdx = 0; // 跳过 CONTENT... 后的位置参数索引
    for (let i = 0; i < positional.length; i++) {
      // 跳过 CONTENT... 占位符
      if (/^CONTENT\.\.\.$/i.test(positional[i])) continue;
      const key = posKeys[posIdx] || ('arg' + posIdx);
      if (params[key] === undefined) params[key] = positional[i];
      posIdx++;
    }
    if (Object.keys(params).length > 0) return { name, params };
  }

  return null;
}

// Parse XML attribute-style toolcall: ToolName key="value" key2="value2"
function parseXmlAttributeToolcall(inner) {
  // Match: ToolName key="value" key2="value2" (last value may be missing closing quote)
  const nameMatch = inner.match(/^(\w+)\s+/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const params = {};

  // Match key="value" pairs (handle missing closing quote on last value)
  const attrRegex = /(\w+)\s*=\s*"([^"]*?)"(?:\s|$)/g;
  let m;
  while ((m = attrRegex.exec(inner)) !== null) {
    params[m[1]] = m[2];
  }

  // Also try key='value' with single quotes
  const attrRegex2 = /(\w+)\s*=\s*'([^']*?)'(?:\s|$)/g;
  while ((m = attrRegex2.exec(inner)) !== null) {
    if (!params[m[1]]) params[m[1]] = m[2];
  }

  // Handle unclosed last quote: key="value without closing quote
  const unclosedRegex = /(\w+)\s*=\s*"([^"]*)$/g;
  while ((m = unclosedRegex.exec(inner)) !== null) {
    if (!params[m[1]]) params[m[1]] = m[2];
  }

  if (Object.keys(params).length === 0) return null;
  return { name, params };
}

// Parse XML arg_key/arg_value style toolcall
// Format: ToolName key</arg_key><arg_value>value</arg_value>key2</arg_key><arg_value>value2</arg_value>
// Also handles: ToolName <arg_key>key</arg_key><arg_value>value</arg_value>
function parseXmlArgKeyToolcall(inner) {
  // 允许工具名后跟空格或直接跟 <arg_key>（如 "bash<arg_key>command</arg_key>..."）
  const nameMatch = inner.match(/^(\w+)(?:\s+|<)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const params = {};

  // Pattern: key</arg_key><arg_value>value</arg_value> 或 <arg_key>key</arg_key><arg_value>value</arg_value>
  // 也处理 <tool_call>key</arg_key>value 这种标签混用情况
  const argRegex = /(?:<arg_key>|<tool_call>)?(\w+)\s*<\/arg_key>\s*(?:<arg_value>)?([\s\S]*?)(?:<\/arg_value>|<arg_key>|<tool_call>|$)/g;
  let m;
  while ((m = argRegex.exec(inner)) !== null) {
    params[m[1]] = m[2].trim();
  }

  if (Object.keys(params).length === 0) return null;
  return { name, params };
}

// Parse XML with name attribute: <toolcall name="ToolName">...</toolcall>
function parseXmlNamedToolcall(inner) {
  const nameMatch = inner.match(/<toolcall\s+name=["']([^"']+)["']/);
  const name = nameMatch ? nameMatch[1] : '';
  const params = {};
  const paramRegex = /<param\s+name=["']([^"']+)["'](?:\s+string=["']([^"']*)["'])?>([\s\S]*?)<\/param>/g;
  let pm;
  while ((pm = paramRegex.exec(inner)) !== null) {
    const pName = pm[1];
    const pValue = pm[3].trim();
    params[pName] = pValue;
  }
  if (!name && Object.keys(params).length === 0) return null;
  return { name, params };
}

// Parse XML tag-params style toolcall
// Format: ToolName\n<param1>value1</param1>\n<param2>value2</param2>
// The first non-empty line is the tool name, followed by <tag>value</tag> pairs.
// Handles unclosed last tag (e.g. <limit>30 at stream end).
function parseXmlTagParamsToolcall(inner) {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  // First non-empty line is the tool name
  const lines = trimmed.split(/\r?\n/);
  let nameLine = '';
  let restStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (l) {
      // Tool name should be a simple identifier (allow / and - for qualified names)
      if (/^[\w\/\-]+$/.test(l)) {
        nameLine = l;
        restStart = lines.slice(0, i + 1).join('\n').length;
        break;
      }
      // If first non-empty line is not a bare identifier, abort
      return null;
    }
  }
  if (!nameLine) return null;

  const rest = trimmed.slice(restStart).trim();
  const params = {};

  // Match <param>value</param> (closed tags)
  const closedRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = closedRegex.exec(rest)) !== null) {
    params[m[1]] = m[2].trim();
  }

  // Match unclosed last tag: <param>value (no closing tag, e.g. stream truncation)
  // Find all <tag> openings, check if each has a closing </tag> after it.
  // If not, extract value from after opening to next '<' or end of string.
  const openingRegex = /<(\w+)>/g;
  let om;
  while ((om = openingRegex.exec(rest)) !== null) {
    const tagName = om[1];
    if (params[tagName] !== undefined) continue; // already captured as closed
    const tagStart = om.index + om[0].length;
    const closingIdx = rest.indexOf(`</${tagName}>`, tagStart);
    if (closingIdx === -1) {
      // Unclosed — extract value from after opening to next '<' or end
      const afterOpening = rest.slice(tagStart);
      const nextLt = afterOpening.indexOf('<');
      const value = nextLt >= 0 ? afterOpening.slice(0, nextLt).trim() : afterOpening.trim();
      if (value) params[tagName] = value;
    }
  }

  if (Object.keys(params).length === 0) return null;
  return { name: nameLine, params };
}

// 计算缺失的闭合 } 数量（忽略字符串内的 {/}）
// 模型有时在 toolcall 截断时漏掉 }}，需要补全才能解析
function countMissingCloseBraces(str) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth > 0 ? depth : 0;
}

// Lenient extraction for malformed JSON with unescaped quotes inside string values.
// Models sometimes generate: {"name":"bash","params":{"command":"node -e "code""}}
// where the " around code are not escaped as \", breaking JSON.parse.
// This function extracts name + params using tolerant regex with lookahead.
function lenientExtractToolcall(inner) {
  const trimmed = inner.trim();

  const nameMatch = trimmed.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  const params = {};

  // Unescape common JSON escape sequences in captured values
  const unescape = (s) => s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  // Find "params":{...} section
  const paramsIdx = trimmed.search(/"params"\s*:\s*\{/);
  if (paramsIdx >= 0) {
    const braceStart = trimmed.indexOf('{', paramsIdx + 9);
    if (braceStart >= 0) {
      const paramsSection = trimmed.slice(braceStart);

      // Match string values: "key":"value"
      // Value extends until: " followed by ,"nextkey": OR " followed by } (end of params object)
      // This tolerates unescaped " inside the value (e.g. node -e "code")
      const strRegex = /"(\w+)"\s*:\s*"([\s\S]*?)(?="\s*,\s*"\w+"\s*:|"\s*\})/g;
      let m;
      while ((m = strRegex.exec(paramsSection)) !== null) {
        params[m[1]] = unescape(m[2]);
      }

      // Match non-string values: "key":number/boolean/null
      const numRegex = /"(\w+)"\s*:\s*(\d+(?:\.\d+)?|true|false|null)/g;
      while ((m = numRegex.exec(paramsSection)) !== null) {
        if (params[m[1]] === undefined) {
          let val = m[2];
          if (val === 'true') val = true;
          else if (val === 'false') val = false;
          else if (val === 'null') val = null;
          else val = Number(val);
          params[m[1]] = val;
        }
      }
    }
  } else {
    // No params wrapper — extract top-level string fields besides "name"
    const strRegex = /"(?!name"\s*:)(\w+)"\s*:\s*"([\s\S]*?)(?="\s*,\s*"\w+"\s*:|"\s*\})/g;
    let m;
    while ((m = strRegex.exec(trimmed)) !== null) {
      params[m[1]] = unescape(m[2]);
    }
  }

  if (Object.keys(params).length === 0) return null;
  return { name, params };
}

function parseToolcallContent(inner) {
  let trimmed = inner.trim();

  // 剥离残留的标签前缀：模型有时输出双重标签如 "<tool_call>toolcall>{...}"
  // 流过滤器匹配外层 <tool_call>...</toolcall> 后，inner 会残留 "toolcall>{...}"
  // 这里剥离开头的 toolcall>/tool_call>/toolcall/tool_call 碎片
  trimmed = trimmed.replace(/^(?:tool_call|toolcall)\s*>?\s*/i, '');

  // 1. Try JSON first (the format we asked the model to use)
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    // Not JSON, try XML formats below
  }

  // 2. Try XML with name attribute: <toolcall name="...">
  const namedResult = parseXmlNamedToolcall(trimmed);
  if (namedResult) {
    console.log(`[anthropic-format] Parsed XML-named toolcall: ${namedResult.name}`);
    return namedResult;
  }

  // 3. Try XML arg_key/arg_value format: ToolName key</arg_key><arg_value>value</arg_value>
  const argKeyResult = parseXmlArgKeyToolcall(trimmed);
  if (argKeyResult) {
    console.log(`[anthropic-format] Parsed XML arg_key toolcall: ${argKeyResult.name}`);
    return argKeyResult;
  }

  // 4. Try XML attribute format: ToolName key="value" key2="value2"
  const attrResult = parseXmlAttributeToolcall(trimmed);
  if (attrResult) {
    console.log(`[anthropic-format] Parsed XML-attribute toolcall: ${attrResult.name}`);
    return attrResult;
  }

  // 5. Try lenient extraction for malformed JSON with unescaped quotes
  //    (e.g. model puts node -e "code" without escaping inner quotes)
  if (trimmed.startsWith('{')) {
    // 5a. 自动补全缺失的闭合 } — 模型有时在 toolcall 截断时漏掉 }}
    //     用花括号配对计算（忽略字符串内的 {/}）确定缺失数量
    const missing = countMissingCloseBraces(trimmed);
    if (missing > 0) {
      const fixed = trimmed + '}'.repeat(missing);
      const lenientFixed = lenientExtractToolcall(fixed);
      if (lenientFixed) {
        console.log(`[anthropic-format] Parsed lenient toolcall (补全 ${missing} 个 }): ${lenientFixed.name}`);
        return lenientFixed;
      }
    }
    const lenientResult = lenientExtractToolcall(trimmed);
    if (lenientResult) {
      console.log(`[anthropic-format] Parsed lenient toolcall: ${lenientResult.name}`);
      return lenientResult;
    }
  }

  // 5b. Try XML tag-params format: ToolName\n<param>value</param>\n<param2>value2</param2>
  //     (model uses XML tags for params instead of JSON, common with glm models)
  const tagParamsResult = parseXmlTagParamsToolcall(trimmed);
  if (tagParamsResult) {
    console.log(`[anthropic-format] Parsed XML tag-params toolcall: ${tagParamsResult.name}`);
    return tagParamsResult;
  }

  // 5c. Try function-call format: funcName({"key":"value"}) 或 funcName(key="value")
  //     (模型有时生成 <tool_call>glob({"path":"..."})</arg_value> 这类非标准格式)
  const funcCallResult = parseFunctionCallToolcall(trimmed);
  if (funcCallResult) {
    console.log(`[anthropic-format] Parsed function-call toolcall: ${funcCallResult.name}`);
    return funcCallResult;
  }

  // 6. Try fixing common JSON issues (trailing commas, single quotes)
  if (trimmed.startsWith('{')) {
    try {
      const fixed = trimmed.replace(/,\s*([}\]])/g, '$1').replace(/'/g, '"');
      return JSON.parse(fixed);
    } catch (e2) {}
  }

  // 7. Try extracting JSON from mixed content
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e3) {}
  }

  throw new Error(`Could not parse toolcall content: ${trimmed.substring(0, 100)}`);
}

function createAnthropicMessage(id, model, content, stopReason, usage, thinking) {
  const contentBlocks = [];

  if (thinking) {
    contentBlocks.push({
      type: 'thinking',
      thinking: thinking
    });
  }

  if (typeof content === 'string') {
    contentBlocks.push({
      type: 'text',
      text: content
    });
  } else if (Array.isArray(content)) {
    contentBlocks.push(...content);
  }

  return {
    id: id || `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: model,
    stop_reason: stopReason || 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens || usage?.prompt_tokens || 0,
      output_tokens: usage?.output_tokens || usage?.completion_tokens || 0
    }
  };
}

function createAnthropicStreamEvent(eventType, data) {
  return {
    type: eventType,
    ...data
  };
}

function createAnthropicMessageStart(id, model, usage) {
  return createAnthropicStreamEvent('message_start', {
    message: {
      id: id || `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: model,
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.input_tokens || usage?.prompt_tokens || 0,
        output_tokens: 0
      }
    }
  });
}

function createAnthropicContentBlockStart(index, type, data) {
  return createAnthropicStreamEvent('content_block_start', {
    index: index,
    content_block: {
      type: type || 'text',
      ...data
    }
  });
}

function createAnthropicContentBlockDelta(index, delta) {
  return createAnthropicStreamEvent('content_block_delta', {
    index: index,
    delta: delta
  });
}

function createAnthropicContentBlockStop(index) {
  return createAnthropicStreamEvent('content_block_stop', {
    index: index
  });
}

function createAnthropicMessageDelta(stopReason, usage) {
  const result = {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason || 'end_turn',
      stop_sequence: null
    }
  };
  if (usage) {
    result.usage = {
      output_tokens: usage.output_tokens || usage.completion_tokens || 0
    };
  }
  return result;
}

function createAnthropicMessageStop() {
  return createAnthropicStreamEvent('message_stop', {});
}

function createAnthropicPing() {
  return createAnthropicStreamEvent('ping', {});
}

function createAnthropicError(error) {
  return {
    type: 'error',
    error: {
      type: error.type || 'api_error',
      message: error.message || 'An error occurred'
    }
  };
}

function anthropicToOpenAIMessages(messages, system) {
  const openaiMessages = [];

  // Sanitize system content: strip billing header if present
  function sanitizeContent(text) {
    if (typeof text === 'string') {
      // Remove x-anthropic-billing-header line that may leak into content
      text = text.replace(/^x-anthropic-billing-header:.*\n?/gm, '');
      // Remove leading/trailing whitespace that accumulates
      text = text.trim();
    }
    return text;
  }

  if (system) {
    let systemContent = typeof system === 'string' ? system :
      (Array.isArray(system) ? system.map(s => s.text).join('\n') : '');
    systemContent = sanitizeContent(systemContent);
    if (systemContent) {
      openaiMessages.push({
        role: 'system',
        content: systemContent
      });
    }
  }

  for (const msg of messages) {
    const role = msg.role;
    let content = msg.content;

    if (typeof content === 'string') {
      openaiMessages.push({ role, content: role === 'system' ? sanitizeContent(content) : content });
    } else if (Array.isArray(content)) {
      const textParts = [];
      const toolResults = [];

      for (const block of content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'image') {
          const source = block.source;
          if (source && source.type === 'base64') {
            textParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${source.media_type};base64,${source.data}`
              }
            });
          }
        } else if (block.type === 'tool_use') {
          // Convert tool_use to <toolcall> format so the model continues using the correct format
          const toolCallText = `<toolcall>${JSON.stringify({ name: block.name, params: block.input || {} })}</toolcall>`;
          textParts.push(toolCallText);
        } else if (block.type === 'tool_result') {
          // Convert tool_result to user message with <tool_result> format
          const resultContent = typeof block.content === 'string' ? block.content :
            (Array.isArray(block.content) ? block.content.map(c => c.text || '').join('\n') : JSON.stringify(block.content));
          toolResults.push({
            role: 'user',
            content: `<tool_result for="${block.tool_use_id}">\n${resultContent}\n</tool_result>`
          });
        }
      }

      if (textParts.length > 0) {
        const textContent = textParts.map(p => typeof p === 'string' ? p : '').join('');
        openaiMessages.push({ role, content: textContent });
      }

      openaiMessages.push(...toolResults);
    }
  }

  return openaiMessages;
}

function openAIToAnthropicMessages(messages) {
  const anthropicMessages = [];
  let system = null;

  for (const msg of messages) {
    if (msg.role === 'system') {
      system = msg.content;
      continue;
    }

    if (msg.role === 'tool') {
      const lastAssistant = [...anthropicMessages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant) {
        if (!lastAssistant.content) lastAssistant.content = [];
        if (typeof lastAssistant.content === 'string') {
          lastAssistant.content = [{ type: 'text', text: lastAssistant.content }];
        }
        lastAssistant.content.push({
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        });
      }
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      const content = [];
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || tc.name,
          input: typeof tc.function?.arguments === 'string' ?
            (function(){ try { return JSON.parse(tc.function.arguments); } catch(e) { return { _raw: tc.function.arguments }; } })() : (tc.input || {})
        });
      }
      anthropicMessages.push({ role: 'assistant', content });
      continue;
    }

    anthropicMessages.push({
      role: msg.role,
      content: msg.content
    });
  }

  return { messages: anthropicMessages, system };
}

function openAIToAnthropicTools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;

  return tools.map(tool => {
    if (tool.type === 'function') {
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} }
      };
    }
    return {
      name: tool.name,
      description: tool.description || '',
      input_schema: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
    };
  });
}

function anthropicToOpenAITools(tools) {
  if (!tools || !Array.isArray(tools)) return undefined;

  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
}

function openAIResponseToAnthropic(response, model) {
  const choice = response.choices?.[0];
  const content = [];
  let stopReason = 'end_turn';

  if (choice?.message?.content) {
    content.push({
      type: 'text',
      text: choice.message.content
    });
  }

  if (choice?.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name || tc.name,
        input: typeof tc.function?.arguments === 'string' ?
          (function(){ try { return JSON.parse(tc.function.arguments); } catch(e) { return { _raw: tc.function.arguments }; } })() : (tc.input || {})
      });
    }
    stopReason = 'tool_use';
  }

  if (choice?.finish_reason === 'length') {
    stopReason = 'max_tokens';
  } else if (choice?.finish_reason === 'stop') {
    stopReason = 'end_turn';
  }

  return createAnthropicMessage(
    response.id?.replace('chatcmpl-', 'msg_'),
    model || response.model,
    content,
    stopReason,
    response.usage
  );
}

function openAIStreamToAnthropic(chunk, messageId, model, state) {
  if (!state) {
    state = {
      messageStarted: false,
      contentBlockIndex: -1,
      currentContentType: null,
      textContent: '',
      toolCalls: []
    };
  }

  const events = [];

  if (!state.messageStarted) {
    events.push({
      event: 'message_start',
      data: createAnthropicMessageStart(messageId, model, { input_tokens: 0 })
    });
    state.messageStarted = true;
  }

  const choice = chunk.choices?.[0];

  if (choice?.delta?.content) {
    if (state.currentContentType !== 'text') {
      if (state.contentBlockIndex >= 0) {
        events.push({
          event: 'content_block_stop',
          data: { index: state.contentBlockIndex }
        });
      }
      state.contentBlockIndex++;
      state.currentContentType = 'text';
      events.push({
        event: 'content_block_start',
        data: createAnthropicContentBlockStart(state.contentBlockIndex, 'text', { text: '' })
      });
    }
    events.push({
      event: 'content_block_delta',
      data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
        type: 'text_delta',
        text: choice.delta.content
      })
    });
    state.textContent += choice.delta.content;
  }

  if (choice?.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      if (tc.function?.name) {
        if (state.contentBlockIndex >= 0 && state.currentContentType !== 'tool_use') {
          events.push({
            event: 'content_block_stop',
            data: { index: state.contentBlockIndex }
          });
        }
        state.contentBlockIndex++;
        state.currentContentType = 'tool_use';
        state.toolCalls[state.contentBlockIndex] = {
          id: tc.id || `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`,
          name: tc.function.name,
          input: ''
        };
        events.push({
          event: 'content_block_start',
          data: createAnthropicContentBlockStart(state.contentBlockIndex, 'tool_use', {
            id: state.toolCalls[state.contentBlockIndex].id,
            name: tc.function.name,
            input: {}
          })
        });
      }
      if (tc.function?.arguments && state.toolCalls[state.contentBlockIndex]) {
        events.push({
          event: 'content_block_delta',
          data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
            type: 'input_json_delta',
            partial_json: tc.function.arguments
          })
        });
        state.toolCalls[state.contentBlockIndex].input += tc.function.arguments;
      }
    }
  }

  if (choice?.finish_reason) {
    if (state.contentBlockIndex >= 0) {
      events.push({
        event: 'content_block_stop',
        data: { index: state.contentBlockIndex }
      });
    }
    const stopReason = choice.finish_reason === 'tool_use' || state.toolCalls.length > 0 ?
      'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn');
    events.push({
      event: 'message_delta',
      data: createAnthropicMessageDelta(stopReason, { output_tokens: 0 })
    });
    events.push({
      event: 'message_stop',
      data: {}
    });
  }

  return { events, state };
}

function llmUtilsChunkToAnthropic(chunk, messageId, model, state, toolMap) {
  if (!state) {
    state = {
      messageStarted: false,
      messageStopped: false,
      contentBlockIndex: -1,
      currentContentType: null,  // 'thinking' | 'text' | 'tool_use'
      textContent: '',
      reasoningContent: '',
      outputTokenCount: 0,
      hasToolUse: false,
      toolCallIndex: {},  // maps tool call index to {id, name, input}
      // Tool call streaming detection (supports both <toolcall> and <tool_call> tag formats)
      toolCallBuffer: '',     // buffer for detecting <toolcall>/<tool_call> tags in text stream
      inToolCall: false,      // currently inside a <toolcall>/<tool_call> tag
      pendingToolCalls: [],   // extracted tool calls waiting to be emitted
      suppressStopEvents: true, // always suppress - outer loop controls when to emit stop events
      stopReason: null,       // last stop reason from done event
    };
  }

  const events = [];

  // Skip any chunks after message_stop has been sent
  if (state.messageStopped) {
    return { events, state };
  }

  if (!state.messageStarted) {
    events.push({
      event: 'message_start',
      data: createAnthropicMessageStart(messageId, model, { input_tokens: 0 })
    });
    state.messageStarted = true;
  }

  // Handle reasoning/thinking content
  if (chunk.type === 'text' && chunk.reasoning) {
    if (state.currentContentType !== 'thinking') {
      // Close previous content block if any
      if (state.contentBlockIndex >= 0) {
        events.push({
          event: 'content_block_stop',
          data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
        });
      }
      state.contentBlockIndex++;
      state.currentContentType = 'thinking';
      events.push({
        event: 'content_block_start',
        data: createAnthropicContentBlockStart(state.contentBlockIndex, 'thinking', { thinking: '' })
      });
    }
    events.push({
      event: 'content_block_delta',
      data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
        type: 'thinking_delta',
        thinking: chunk.reasoning
      })
    });
    state.reasoningContent += chunk.reasoning;
    state.outputTokenCount += Math.ceil(chunk.reasoning.length / 4);
  }

  // Handle text content - with <toolcall>/<tool_call> tag detection and filtering
  if (chunk.type === 'text' && chunk.content) {
    state.textContent += chunk.content;
    state.outputTokenCount += Math.ceil(chunk.content.length / 4);

    // Process text through <toolcall>/<tool_call> tag detector
    let textToEmit = '';
    const content = chunk.content;

    for (let i = 0; i < content.length; i++) {
      const ch = content[i];

      if (state.inToolCall) {
        // Inside a <toolcall>/<tool_call> tag - buffer until closing tag
        state.toolCallBuffer += ch;

        // Check if buffer ends with </toolcall> or </tool_call>
        let closingTag = null;
        if (state.toolCallBuffer.endsWith('</toolcall>')) {
          closingTag = '</toolcall>';
        } else if (state.toolCallBuffer.endsWith('</tool_call>')) {
          closingTag = '</tool_call>';
        }
        if (closingTag) {
          // Extract the tool call JSON
          const inner = state.toolCallBuffer.slice(0, -closingTag.length);
          try {
            const toolData = parseToolcallContent(inner);
            state.pendingToolCalls.push({
              name: toolData.name || toolData.function?.name || '',
              input: toolData.params || toolData.arguments || toolData.input || {}
            });
          } catch (e) {
            console.error(`[anthropic-format] Failed to parse toolcall: ${e.message}, raw: ${inner.substring(0, 100)}`);
          }
          state.inToolCall = false;
          state.toolCallBuffer = '';
        }
      } else {
        // Not inside a toolcall - check for <toolcall>/<tool_call> start
        state.toolCallBuffer += ch;

        // Check if buffer might be starting a <toolcall> or <tool_call> tag
        if (ch === '>') {
          if (state.toolCallBuffer.endsWith('<toolcall>') || state.toolCallBuffer.match(/<toolcall\s+[^>]*>$/) ||
              state.toolCallBuffer.endsWith('<tool_call>') || state.toolCallBuffer.match(/<tool_call\s+[^>]*>$/)) {
            // Found <toolcall>/<tool_call> start - switch to tool call mode
            state.inToolCall = true;
            // Emit any text before the tag
            const beforeTag = state.toolCallBuffer.match(/^(.*?)(<(?:tool_call|toolcall)(?:\s[^>]*)?>)$/);
            if (beforeTag) {
              textToEmit += beforeTag[1];
              state.toolCallBuffer = '';
            }
            continue;
          }
        }

        // If buffer is getting long and doesn't match <toolcall>/<tool_call>, flush it
        if (state.toolCallBuffer.length > 100) {
          const buf = state.toolCallBuffer;
          const couldBeToolcall = '<toolcall>'.startsWith(buf) || '<toolcall '.startsWith(buf) ||
            '<tool_call>'.startsWith(buf) || '<tool_call '.startsWith(buf) ||
            (buf.includes('<') && buf.lastIndexOf('<') > buf.length - 12);
          if (!couldBeToolcall) {
            textToEmit += buf;
            state.toolCallBuffer = '';
          } else if (buf.includes('<')) {
            const ltIndex = buf.lastIndexOf('<');
            const afterLt = buf.slice(ltIndex);
            if (!'<toolcall>'.startsWith(afterLt) && !'<toolcall '.startsWith(afterLt) &&
                !'<tool_call>'.startsWith(afterLt) && !'<tool_call '.startsWith(afterLt)) {
              textToEmit += buf.slice(0, ltIndex + 1);
              state.toolCallBuffer = buf.slice(ltIndex + 1);
            }
          }
        }
      }
    }

    // Emit filtered text (text without <toolcall>/<tool_call> tags)
    if (textToEmit) {
      if (state.currentContentType !== 'text') {
        // Close previous content block if any
        if (state.contentBlockIndex >= 0) {
          events.push({
            event: 'content_block_stop',
            data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
          });
        }
        state.contentBlockIndex++;
        state.currentContentType = 'text';
        events.push({
          event: 'content_block_start',
          data: createAnthropicContentBlockStart(state.contentBlockIndex, 'text', { text: '' })
        });
      }
      events.push({
        event: 'content_block_delta',
        data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
          type: 'text_delta',
          text: textToEmit
        })
      });
    }
  }

  // Handle tool calls
  if (chunk.type === 'text' && chunk.tool_calls && Array.isArray(chunk.tool_calls)) {
    for (let i = 0; i < chunk.tool_calls.length; i++) {
      const tc = chunk.tool_calls[i];

      // Close previous content block if any
      if (state.contentBlockIndex >= 0 && state.currentContentType !== 'tool_use') {
        events.push({
          event: 'content_block_stop',
          data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
        });
      }

      state.contentBlockIndex++;
      state.currentContentType = 'tool_use';
      state.hasToolUse = true;

      const toolId = tc.id || `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
      const toolName = tc.function?.name || tc.name || '';
      const toolInput = tc.function?.arguments || '{}';

      state.toolCallIndex[state.contentBlockIndex] = {
        id: toolId,
        name: toolName,
        input: toolInput
      };

      events.push({
        event: 'content_block_start',
        data: createAnthropicContentBlockStart(state.contentBlockIndex, 'tool_use', {
          id: toolId,
          name: toolName,
          input: {}
        })
      });

      // Send the input as a single delta (Trae sends complete tool calls, not streaming)
      if (toolInput && toolInput !== '{}') {
        events.push({
          event: 'content_block_delta',
          data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
            type: 'input_json_delta',
            partial_json: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
          })
        });
      }

      // Close this tool_use block immediately since we have the complete data
      events.push({
        event: 'content_block_stop',
        data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
      });
      state.currentContentType = null;
    }
  }

  if (chunk.type === 'token_usage' && chunk.data) {
    if (chunk.data.completion_tokens) {
      state.outputTokenCount = chunk.data.completion_tokens;
    }
  }

  if (chunk.type === 'done') {
    // Flush toolCallBuffer
    if (state.toolCallBuffer) {
      if (state.inToolCall) {
        // <toolcall>/<tool_call> was opened but closing tag never arrived (e.g. max_tokens truncation)
        // Try to extract tool call from the incomplete buffer
        const bufferContent = state.toolCallBuffer.trim();
        let recoveredAsToolCall = false;
        try {
          const toolData = JSON.parse(bufferContent);
          state.pendingToolCalls.push({
            name: toolData.name || toolData.function?.name || '',
            input: toolData.params || toolData.arguments || toolData.input || {}
          });
          recoveredAsToolCall = true;
          console.log(`[anthropic-format] Recovered incomplete toolcall from buffer: ${toolData.name}`);
        } catch (e) {
          // Buffer is not valid JSON on its own - try to find JSON in it
          const jsonMatch = bufferContent.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const toolData = JSON.parse(jsonMatch[0]);
              state.pendingToolCalls.push({
                name: toolData.name || toolData.function?.name || '',
                input: toolData.params || toolData.arguments || toolData.input || {}
              });
              recoveredAsToolCall = true;
              console.log(`[anthropic-format] Recovered toolcall from partial buffer: ${toolData.name}`);
            } catch (e2) {
              // Not JSON — try full parseToolcallContent (handles XML tag-params etc.)
              try {
                const toolData = parseToolcallContent(bufferContent);
                state.pendingToolCalls.push({
                  name: toolData.name || toolData.function?.name || '',
                  input: toolData.params || toolData.arguments || toolData.input || {}
                });
                recoveredAsToolCall = true;
                console.log(`[anthropic-format] Recovered toolcall via parseToolcallContent: ${toolData.name}`);
              } catch (e3) {
                // Not a real toolcall — likely a literal <toolcall> string in model text
              }
            }
          } else {
            // No JSON at all — try full parseToolcallContent (handles XML tag-params etc.)
            try {
              const toolData = parseToolcallContent(bufferContent);
              state.pendingToolCalls.push({
                name: toolData.name || toolData.function?.name || '',
                input: toolData.params || toolData.arguments || toolData.input || {}
              });
              recoveredAsToolCall = true;
              console.log(`[anthropic-format] Recovered toolcall via parseToolcallContent: ${toolData.name}`);
            } catch (e3) {
              // Not a real toolcall — likely a literal <toolcall> string in model text
            }
          }
        }
        if (!recoveredAsToolCall) {
          // No parseable JSON — the <toolcall> was likely a literal string in
          // the model's text (e.g. describing code), not a real tool call.
          // Emit the original buffer as plain text so content is not lost.
          console.warn(`[anthropic-format] no JSON in toolcall buffer at stream end, emitting as text: ${bufferContent.substring(0, 100)}`);
          const remaining = state.toolCallBuffer;
          if (state.currentContentType !== 'text') {
            if (state.contentBlockIndex >= 0) {
              events.push({
                event: 'content_block_stop',
                data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
              });
            }
            state.contentBlockIndex++;
            state.currentContentType = 'text';
            events.push({
              event: 'content_block_start',
              data: createAnthropicContentBlockStart(state.contentBlockIndex, 'text', { text: '' })
            });
          }
          events.push({
            event: 'content_block_delta',
            data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
              type: 'text_delta',
              text: remaining
            })
          });
        }
        state.inToolCall = false;
        state.toolCallBuffer = '';
      } else {
        // Not inside a toolcall - flush remaining buffer as text
        const remaining = state.toolCallBuffer;
        state.toolCallBuffer = '';
        if (remaining) {
          if (state.currentContentType !== 'text') {
            if (state.contentBlockIndex >= 0) {
              events.push({
                event: 'content_block_stop',
                data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
              });
            }
            state.contentBlockIndex++;
            state.currentContentType = 'text';
            events.push({
              event: 'content_block_start',
              data: createAnthropicContentBlockStart(state.contentBlockIndex, 'text', { text: '' })
            });
          }
          events.push({
            event: 'content_block_delta',
            data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
              type: 'text_delta',
              text: remaining
            })
          });
        }
      }
    }

    // Fallback: check for <toolcall>/<tool_call> tags in accumulated textContent
    // (in case the streaming detector missed some due to chunk boundaries)
    // Support both closed and unclosed tags, and both <toolcall> and <tool_call> formats
    const extractedToolCalls = [];

    // Strict match: <toolcall>...</toolcall> or <tool_call>...</tool_call>
    const strictRegex = /<tool_?call>\s*([\s\S]*?)\s*<\/tool_?call>/g;
    let match;
    while ((match = strictRegex.exec(state.textContent)) !== null) {
      try {
        const toolData = parseToolcallContent(match[1]);
        const tc = {
          name: toolData.name || toolData.function?.name || '',
          input: toolData.params || toolData.arguments || toolData.input || {}
        };
        const alreadyDetected = state.pendingToolCalls.some(
          p => p.name === tc.name && JSON.stringify(p.input) === JSON.stringify(tc.input)
        );
        if (!alreadyDetected) {
          extractedToolCalls.push(tc);
        }
      } catch (e) {
        console.error(`[anthropic-format] Failed to parse toolcall (strict): ${e.message}`);
      }
    }

    // Loose match: <toolcall>... or <tool_call>... without closing tag (handles truncation)
    const looseRegex = /<tool_?call>\s*([\s\S]*?)(?:<\/tool_?call>|$)/g;
    while ((match = looseRegex.exec(state.textContent)) !== null) {
      try {
        const raw = match[1].trim();
        if (!raw) continue;
        const toolData = parseToolcallContent(raw);
        const tc = {
          name: toolData.name || toolData.function?.name || '',
          input: toolData.params || toolData.arguments || toolData.input || {}
        };
        const alreadyDetected = state.pendingToolCalls.some(
          p => p.name === tc.name && JSON.stringify(p.input) === JSON.stringify(tc.input)
        ) || extractedToolCalls.some(
          p => p.name === tc.name && JSON.stringify(p.input) === JSON.stringify(tc.input)
        );
        if (!alreadyDetected) {
          extractedToolCalls.push(tc);
          console.log(`[anthropic-format] Recovered toolcall from loose match: ${tc.name}`);
        }
      } catch (e) {
        // Not valid JSON, skip
      }
    }

    // Merge streaming-detected and fallback-detected tool calls
    const allToolCalls = [...state.pendingToolCalls, ...extractedToolCalls];
    const hasToolCalls = allToolCalls.length > 0;

    // Close any open content block (but DON'T reset contentBlockIndex)
    if (state.contentBlockIndex >= 0 && state.currentContentType !== null) {
      events.push({
        event: 'content_block_stop',
        data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
      });
      state.currentContentType = null;
      // IMPORTANT: Do NOT reset contentBlockIndex, keep it incrementing for tool_use blocks
    }

    // Create tool_use content blocks for all extracted tool calls
    if (hasToolCalls) {
      state.hasToolUse = true;

      for (const tc of allToolCalls) {
        // Map tool name using toolMap if available
        let mappedName = tc.name;
        if (toolMap) {
          const nameLower = tc.name.toLowerCase();
          if (toolMap[nameLower]) {
            mappedName = toolMap[nameLower];
          } else if (toolMap[tc.name]) {
            mappedName = toolMap[tc.name];
          }
        }

        state.contentBlockIndex++;
        const toolId = `toolu_${uuidv4().replace(/-/g, '').substring(0, 24)}`;

        events.push({
          event: 'content_block_start',
          data: createAnthropicContentBlockStart(state.contentBlockIndex, 'tool_use', {
            id: toolId,
            name: mappedName,
            input: {}
          })
        });

        const inputJson = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input);
        if (inputJson && inputJson !== '{}') {
          events.push({
            event: 'content_block_delta',
            data: createAnthropicContentBlockDelta(state.contentBlockIndex, {
              type: 'input_json_delta',
              partial_json: inputJson
            })
          });
        }

        events.push({
          event: 'content_block_stop',
          data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
        });
      }

      console.log(`[anthropic-format] Extracted ${allToolCalls.length} tool calls: ${allToolCalls.map(t => t.name).join(', ')} -> mapped: ${allToolCalls.map(t => toolMap?.[t.name.toLowerCase()] || t.name).join(', ')}`);
    }

    // Determine stop_reason
    let stopReason = 'end_turn';
    if (state.hasToolUse) {
      stopReason = 'tool_use';
    } else if (chunk.finish_reason === 'max_tokens') {
      stopReason = 'max_tokens';
    }
    state.stopReason = stopReason;

    // Only emit message_delta and message_stop if not suppressed (auto-continue may suppress these)
    if (!state.suppressStopEvents) {
      events.push({
        event: 'message_delta',
        data: createAnthropicMessageDelta(stopReason, { output_tokens: state.outputTokenCount })
      });
      events.push({
        event: 'message_stop',
        data: createAnthropicStreamEvent('message_stop', {})
      });
    }
    state.messageStopped = true;
  }

  if (chunk.type === 'error') {
    // Close any open content block before sending error
    if (state.contentBlockIndex >= 0 && state.currentContentType !== null) {
      events.push({
        event: 'content_block_stop',
        data: createAnthropicStreamEvent('content_block_stop', { index: state.contentBlockIndex })
      });
      state.contentBlockIndex = -1;
    }
    events.push({
      event: 'message_delta',
      data: createAnthropicMessageDelta('end_turn', { output_tokens: state.outputTokenCount })
    });
    events.push({
      event: 'message_stop',
      data: createAnthropicStreamEvent('message_stop', {})
    });
    state.messageStopped = true;
  }

  return { events, state };
}

module.exports = {
  createAnthropicMessage,
  createAnthropicStreamEvent,
  createAnthropicMessageStart,
  createAnthropicContentBlockStart,
  createAnthropicContentBlockDelta,
  createAnthropicContentBlockStop,
  createAnthropicMessageDelta,
  createAnthropicMessageStop,
  createAnthropicPing,
  createAnthropicError,
  anthropicToOpenAIMessages,
  openAIToAnthropicMessages,
  openAIToAnthropicTools,
  anthropicToOpenAITools,
  openAIResponseToAnthropic,
  openAIStreamToAnthropic,
  llmUtilsChunkToAnthropic,
  parseXmlNamedToolcall,
  parseXmlAttributeToolcall,
  parseXmlArgKeyToolcall,
  parseToolcallContent,
  extractFirstJsonObject
};
