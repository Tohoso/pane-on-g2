import { describe, expect, it } from "vitest";
import { activeSlotSnapshot, createInitialSlotState, transitionSlotState } from "../src/slot-state";

describe("per-slot state", () => {
  it("starts with four independent slots and cc active", () => {
    const state = createInitialSlotState();

    expect(state.activeSlot).toBe("cc");
    expect(Object.keys(state.slots)).toEqual(["cc", "alpha", "beta", "gamma"]);
    expect(activeSlotSnapshot(state)).toMatchObject({
      slot: "cc",
      status: "idle",
      assistantText: "",
      paneSnapshot: "",
      paneSnapshotSeq: 0,
      g2HistoryOffset: 0,
    });
  });

  it("initializes every slot with live G2 history mode", () => {
    const state = createInitialSlotState();

    expect(Object.values(state.slots).map((slot) => slot.g2HistoryOffset)).toEqual([0, 0, 0, 0]);
  });

  it("updates only the slot carried by incoming events", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, { type: "slot_select", slot: "alpha", ts: 1 });
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "beta",
      text: "beta output",
      seq: 1,
      turnId: "b1",
      ts: 2,
    });

    expect(state.activeSlot).toBe("alpha");
    expect(state.slots.beta).toMatchObject({ status: "streaming", assistantText: "beta output" });
    expect(state.slots.alpha).toMatchObject({ status: "idle", assistantText: "" });
  });

  it("clears one slot assistant text on that slot's new user prompt", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "gamma",
      text: "old",
      seq: 1,
      turnId: "g1",
      ts: 1,
    });
    state = transitionSlotState(state, {
      type: "user_prompt",
      slot: "gamma",
      text: "new prompt",
      source: "tmux",
      ts: 2,
    });

    expect(state.slots.gamma).toMatchObject({ status: "busy", assistantText: "" });
  });

  it("does not change G2 history offset during transcript transitions", () => {
    let state = createInitialSlotState();
    state = {
      ...state,
      slots: {
        ...state.slots,
        cc: {
          ...state.slots.cc,
          g2HistoryOffset: 160,
        },
      },
    };
    state = transitionSlotState(state, {
      type: "user_prompt",
      slot: "cc",
      text: "ping",
      source: "g2_text",
      ts: 1,
    });
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "cc",
      text: "pong",
      seq: 1,
      turnId: "a1",
      ts: 2,
    });
    state = transitionSlotState(state, {
      type: "result",
      slot: "cc",
      turnId: "a1",
      ok: true,
      ts: 3,
    });

    expect(state.slots.cc.g2HistoryOffset).toBe(160);
  });

  it("appends a user turn and streaming assistant placeholder on user prompt", () => {
    const state = transitionSlotState(createInitialSlotState(), {
      type: "user_prompt",
      slot: "cc",
      text: "今日の予定を短く",
      source: "tmux",
      ts: 10,
    });

    expect(state.slots.cc.transcript).toMatchObject([
      { role: "user", text: "今日の予定を短く", source: "tmux", ts: 10 },
      { role: "assistant", text: "", status: "streaming", ts: 10 },
    ]);
  });

  it("streams text deltas into the latest assistant turn", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, {
      type: "user_prompt",
      slot: "cc",
      text: "ping",
      source: "g2_text",
      ts: 1,
    });
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "cc",
      text: "pon",
      seq: 1,
      turnId: "a1",
      ts: 2,
    });
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "cc",
      text: "g",
      seq: 2,
      turnId: "a1",
      ts: 3,
    });

    expect(state.slots.cc.assistantText).toBe("pong");
    expect(state.slots.cc.transcript.at(-1)).toMatchObject({
      role: "assistant",
      text: "pong",
      status: "streaming",
    });
  });

  it("marks the latest assistant turn complete on result", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, {
      type: "user_prompt",
      slot: "cc",
      text: "ping",
      source: "g2_text",
      ts: 1,
    });
    state = transitionSlotState(state, {
      type: "text_delta",
      slot: "cc",
      text: "pong",
      seq: 1,
      turnId: "a1",
      ts: 2,
    });
    state = transitionSlotState(state, {
      type: "result",
      slot: "cc",
      turnId: "a1",
      ok: true,
      ts: 3,
    });

    expect(state.slots.cc.status).toBe("idle");
    expect(state.slots.cc.transcript.at(-1)).toMatchObject({
      role: "assistant",
      text: "pong",
      status: "complete",
    });
  });

  it("replays multiple prompt and delta sequences as chat history", () => {
    let state = createInitialSlotState();
    for (let index = 0; index < 3; index += 1) {
      state = transitionSlotState(state, {
        type: "user_prompt",
        slot: "alpha",
        text: `prompt ${index}`,
        source: "tmux",
        ts: index * 10,
      });
      state = transitionSlotState(state, {
        type: "text_delta",
        slot: "alpha",
        text: `answer ${index}`,
        seq: index,
        turnId: `a${index}`,
        ts: index * 10 + 1,
      });
    }

    expect(state.slots.alpha.transcript).toHaveLength(6);
    expect(state.slots.alpha.transcript.map((turn) => turn.text)).toEqual([
      "prompt 0",
      "answer 0",
      "prompt 1",
      "answer 1",
      "prompt 2",
      "answer 2",
    ]);
    expect(state.slots.alpha.transcript[1]).toMatchObject({ role: "assistant", status: "complete" });
    expect(state.slots.alpha.transcript[5]).toMatchObject({ role: "assistant", status: "streaming" });
  });

  it("caps transcript at 200 turns and drops the oldest turns", () => {
    let state = createInitialSlotState();
    for (let index = 0; index < 125; index += 1) {
      state = transitionSlotState(state, {
        type: "user_prompt",
        slot: "beta",
        text: `prompt ${index}`,
        source: "tmux",
        ts: index * 10,
      });
      state = transitionSlotState(state, {
        type: "text_delta",
        slot: "beta",
        text: `answer ${index}`,
        seq: index,
        turnId: `b${index}`,
        ts: index * 10 + 1,
      });
    }

    expect(state.slots.beta.transcript).toHaveLength(200);
    expect(state.slots.beta.transcript[0]).toMatchObject({ role: "user", text: "prompt 25" });
    expect(state.slots.beta.transcript.at(-1)).toMatchObject({ role: "assistant", text: "answer 124" });
  });

  it("marks only the active slot reconnecting on disconnect", () => {
    let state = createInitialSlotState("beta");
    state = transitionSlotState(state, { type: "disconnect", ts: 1 });

    expect(state.slots.beta.status).toBe("reconnecting");
    expect(state.slots.cc.status).toBe("idle");
  });

  it("updates pane snapshot content and sequence by slot", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, {
      type: "pane_snapshot",
      slot: "alpha",
      content: "current pane",
      seq: 4,
      ts: 10,
    });

    expect(state.slots.alpha).toMatchObject({
      paneSnapshot: "current pane",
      paneSnapshotSeq: 4,
      lastEventAt: 10,
    });
    expect(state.slots.cc).toMatchObject({ paneSnapshot: "", paneSnapshotSeq: 0 });
  });

  it("ignores out-of-order pane snapshots", () => {
    let state = createInitialSlotState();
    state = transitionSlotState(state, {
      type: "pane_snapshot",
      slot: "cc",
      content: "newer",
      seq: 2,
      ts: 2,
    });
    state = transitionSlotState(state, {
      type: "pane_snapshot",
      slot: "cc",
      content: "older",
      seq: 1,
      ts: 3,
    });

    expect(state.slots.cc).toMatchObject({ paneSnapshot: "newer", paneSnapshotSeq: 2, lastEventAt: 2 });
  });
});
