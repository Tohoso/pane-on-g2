// jsonl-tail.js — Claude Code の session.jsonl を tail して clean な text_delta を emit
// pipe-pane と違って TUI 装飾を一切含まない。assistant の content block を直接読む。

import { readFileSync, statSync, watchFile, existsSync } from "node:fs";
import { getLatestSessionJsonl } from "./slots.js";

/**
 * 1 slot 用 jsonl tailer。
 * 起動時に最新 jsonl の位置を末尾に合わせ、以降の増分だけを emit する。
 * 新しい session に切り替わった (より新しい mtime の jsonl が出現) 場合は switch する。
 */
export class JsonlTailer {
  constructor(slot, onEvent, opts = {}) {
    this.slot = slot;
    this.onEvent = onEvent;
    this.cwd = opts.cwd || process.env.PANE_ON_G2_SESSION_CWD || process.cwd();
    this.pollMs = opts.pollMs || 500;
    this.path = null;
    this.position = 0;
    this.stopped = false;
    // 同一 message_id の text_block が連続した場合に重複 emit しない
    this.emittedKeys = new Set();
  }

  start() {
    this._refreshPath();
    if (!this.path) {
      // jsonl が無くても定期チェックで出てきたら拾う
      this._scheduleRefresh();
      return;
    }
    this._setupWatch();
    this._scheduleRefresh();
  }

  _refreshPath() {
    const latest = getLatestSessionJsonl(this.slot, this.cwd);
    if (!latest) return;
    if (latest !== this.path) {
      // 新 session に switch
      this.path = latest;
      try {
        this.position = statSync(latest).size;
      } catch {
        this.position = 0;
      }
      this.emittedKeys.clear();
      this._setupWatch();
    }
  }

  _setupWatch() {
    if (!this.path || !existsSync(this.path)) return;
    watchFile(
      this.path,
      { interval: this.pollMs, persistent: false },
      (curr, _prev) => {
        if (this.stopped) return;
        if (curr.size <= this.position) {
          if (curr.size < this.position) this.position = 0;
          return;
        }
        this._readNew(curr.size);
      }
    );
  }

  _scheduleRefresh() {
    // 30 秒ごとに jsonl 候補を refresh (新 session 切替検知)
    setTimeout(() => {
      if (this.stopped) return;
      this._refreshPath();
      this._scheduleRefresh();
    }, 30_000);
  }

  _readNew(toSize) {
    let raw;
    try {
      const fd = require_fs().openSync(this.path, "r");
      const buf = Buffer.alloc(toSize - this.position);
      require_fs().readSync(fd, buf, 0, buf.length, this.position);
      require_fs().closeSync(fd);
      raw = buf.toString("utf8");
    } catch {
      return;
    }
    this.position = toSize;

    // 行ごと parse (最後の不完全行は今回は無視、次サイクルで読む)
    const lines = raw.split("\n");
    if (!raw.endsWith("\n")) {
      // 最後の不完全行は drop して position を巻き戻す
      const lastLen = Buffer.byteLength(lines[lines.length - 1], "utf8");
      this.position -= lastLen;
      lines.pop();
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      this._processLine(line);
    }
  }

  _processLine(line) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }

    const type = obj.type;

    if (type === "user") {
      const text = extractUserText(obj);
      if (text && !text.startsWith("<tool_use_error>") && !text.startsWith("[Request interrupted")) {
        // 新ターン開始の trigger として system init を先行 emit。
        // アプリが「これから新応答が来る」flag を立てる仮説。
        this.onEvent({
          type: "system",
          subtype: "init",
          session_id: obj.sessionId || "",
          cwd: this.cwd,
          model: "claude-opus-4-7",
          tools: ["Read", "Edit", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"],
          permissionMode: "acceptEdits",
          mcp_servers: [],
        });
        // user_prompt は prompt() で既に emit してる重複の可能性があるが、
        // tmux 直入力の場合はこっちでしか拾えない。重複は UI 側で吸収される想定。
        this.onEvent({ type: "user_prompt", text });
      }
    } else if (type === "assistant") {
      const msg = obj.message;
      if (!msg) return;
      const msgId = msg.id || "no-id";
      const content = msg.content || [];
      const blockIdx = obj.blockIdx ?? 0;
      let blockCounter = 0;
      for (const block of content) {
        const key = `${msgId}#${blockIdx}#${blockCounter++}#${block.type}`;
        if (this.emittedKeys.has(key)) continue;
        this.emittedKeys.add(key);

        if (block.type === "text" && block.text?.trim()) {
          this.onEvent({ type: "text_delta", text: block.text });
        } else if (block.type === "tool_use") {
          this.onEvent({
            type: "tool_start",
            name: block.name || "",
            toolId: block.id || "",
          });
        }
      }
      // stop_reason が end_turn → result emit
      const stop = msg.stop_reason;
      if (stop === "end_turn" || stop === "stop_sequence") {
        const usage = msg.usage || {};
        this.onEvent({
          type: "result",
          success: true,
          text: "",
          sessionId: obj.sessionId || "",
          costUsd: 0,
          provider: "ayu",
          turns: 1,
          durationMs: 0,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
        });
      }
    }
    // last-prompt は無視: prompt 受信時のメタ entry で、応答完了ではない。
    // 完了は assistant.stop_reason === "end_turn" で判定する (上の分岐で result emit 済)。
  }

  stop() {
    this.stopped = true;
    // watchFile は persistent:false なので process exit 時に自動停止
  }
}

// ESM で fs を遅延 require するヘルパー (closure 軽量化)
import * as fsMod from "node:fs";
function require_fs() {
  return fsMod;
}

function extractUserText(obj) {
  const c = obj.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b?.type === "text" || typeof b === "string")
      .map((b) => (typeof b === "string" ? b : b.text || ""))
      .join("\n")
      .trim();
  }
  return "";
}
