import { expect, test } from "bun:test";
import { dismissPopup, observePopups, popupDigest, sameContent, type PopupContent, type PopupObservation } from "./popups.ts";

function capture(text: string, truncated = false, source: "text" | "tooltip" = "text"): PopupContent {
  return { fields: [{ control: "Controls.HeaderLabel", text, source }], truncated, unreadable: [] };
}

test("popup discovery does not advertise a missing native close handler", async () => {
  const observations = await observePopups(async () => ({ visible: true, active: true, closeable: false, title: "Eruption" }), { id: "popup:natural-disaster" });
  expect(observations).toMatchObject([{ id: "popup:natural-disaster", visible: true, dismissable: false, title: "Eruption" }]);
});

test("a screen that is not showing is reported as gone and its native handler never runs", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:natural-disaster", async () => {
    calls++;
    return { present: false };
  });
  expect(calls).toBe(1);
  expect(result.gone).toBe(true);
  expect(result.dismissed).toBe(false);
  expect(result.status).toBe("ok");
});

test("an informational close cannot claim dismissal while a queued successor remains visible", async () => {
  const replies = [{ present: true, closed: true }, { active: true, visible: true }];
  const result = await dismissPopup("popup:natural-disaster", async () => replies.shift());
  expect(result.dismissed).toBe(false);
  expect(result.advanced).toBe(true);
});

test("native close failure is not converted into a successful dismissal or retried", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:natural-disaster", async () => {
    calls++;
    return calls === 1 ? { present: true, closed: false, missing: "Close" } : { closed: true };
  });
  expect(result.status).toBe("error");
  expect(result.dismissed).toBe(false);
  expect(result.error).toContain("not callable");
  expect(calls).toBe(1);
});

test("terminal game-over screens cannot be dismissed through a cosmetic adapter", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:end-game-menu", async () => { calls++; throw new Error("must not execute"); });
  expect(result.status).toBe("not-dismissable");
  expect(result.dismissed).toBe(false);
  expect(calls).toBe(0);
});

test("a close refuses to run when the screen no longer shows the content that was presented", async () => {
  const sent = capture("Pottery");
  let calls = 0;
  const result = await dismissPopup("popup:tech-civic-completed", async () => {
    calls++;
    return { present: true, matched: false, content: { fields: [{ control: "Controls.ResearchName", text: "Writing", source: "text" }], truncated: false, unreadable: [] } };
  }, sent);

  expect(calls).toBe(1);
  expect(result.dismissed).toBe(false);
  expect(result.changed).toBe(true);
  expect(result.content).toEqual({
    fields: [{ control: "Controls.ResearchName", text: "Writing", source: "text" }],
    truncated: false,
    unreadable: [],
  });
  expect(result.note!.length).toBeGreaterThan(0);
});

test("a guarded close requires a capturing screen, so a comparison can never be faked", async () => {
  await expect(dismissPopup("popup:governor-panel", async () => ({ closed: true }), capture("Governors")))
    .rejects.toThrow("guarded close needs a capture probe");
});

test("only information-only screens whose full text was captured may be closed automatically", async () => {
  const [truncated] = await observePopups(async () => ({
    visible: true, active: true, closeable: true, title: "Moment",
    content: { fields: [{ control: "root/1", text: "A moment", source: "text" }], truncated: true, unreadable: [] },
  }), { id: "popup:historic-moments" });
  expect(truncated!.contentStatus).toBe("captured");
  expect(truncated!.content!.truncated).toBe(true);
  expect(truncated!.autoDismissible).toBe(false);
  expect(truncated!.autoDismissReason!.length).toBeGreaterThan(0);

  const [empty] = await observePopups(async () => ({ visible: true, active: true, closeable: true }), { id: "popup:era-complete" });
  expect(empty!.contentStatus).toBe("unsupported");
  expect(empty!.autoDismissible).toBe(false);
  expect(empty!.autoDismissReason!.length).toBeGreaterThan(0);

  const [modal] = await observePopups(async () => ({
    visible: true, active: true, closeable: true,
    content: { fields: [{ control: "Controls.PopupTitle", text: "Are you sure?", source: "text" }], truncated: false, unreadable: [] },
  }), { id: "popup:in-game" });
  expect(modal!.contentStatus).toBe("captured");
  expect(modal!.autoDismissible).toBe(false);
  expect(modal!.autoDismissReason!.length).toBeGreaterThan(0);

  const [chooser] = await observePopups(async () => ({ visible: true, active: true, closeable: true }), { id: "popup:event" });
  expect(chooser!.autoDismissible).toBe(false);
  expect(chooser!.autoDismissReason!.length).toBeGreaterThan(0);
});

test("icon-only content is reported as unreadable instead of being silently dropped", async () => {
  const [observation] = await observePopups(async () => ({
    visible: true, active: true, closeable: true, title: "RESEARCH COMPLETE",
    content: {
      fields: [
        { control: "Controls.HeaderLabel", text: "RESEARCH COMPLETE", source: "text" },
        { control: "Controls.ResearchName", text: "POTTERY", source: "text" },
        { control: "root/1/2", text: "Unlocks: 2", source: "text" },
      ],
      truncated: false,
      unreadable: ["Controls.UnlockStack renders icon-only instances"],
    },
  }), { id: "popup:tech-civic-completed" });

  expect(observation!.contentStatus).toBe("captured");
  expect(observation!.content!.fields.map(field => field.source)).toEqual(["text", "text", "text"]);
  expect(observation!.content!.unreadable).toEqual(["Controls.UnlockStack renders icon-only instances"]);
  // Nothing is closed over content the capture cannot read: the screen stays up, and the unreadable
  // part is named for the caller instead of being blessed as captured text.
  expect(observation!.autoDismissible).toBe(false);
});

test("a malformed capture is an error, never a partial claim of preserved text", async () => {
  const [broken] = await observePopups(async () => ({
    visible: true, active: true, closeable: true,
    content: { fields: [{ control: "root/1", text: 7 }] },
  }), { id: "popup:historic-moments" });
  expect(broken!.content).toBeNull();
  expect(broken!.contentStatus).toBe("error");
  expect(broken!.autoDismissible).toBe(false);
  expect(broken!.autoDismissReason!.length).toBeGreaterThan(0);
});

test("content comparison is exact, so a rewritten screen is never mistaken for the captured one", () => {
  expect(sameContent(capture("Pottery"), capture("Pottery"))).toBe(true);
  expect(sameContent(capture("Pottery"), capture("Writing"))).toBe(false);
  expect(sameContent(capture("Pottery"), capture("Pottery", true))).toBe(false);
  expect(sameContent(capture("Pottery"), capture("Pottery", false, "tooltip"))).toBe(false);
  expect(sameContent(capture("Pottery"), { ...capture("Pottery"), unreadable: ["icon-only slots"] })).toBe(false);
  expect(sameContent(null, capture("Pottery"))).toBe(false);
});

function observed(fields: { control: string; text: string; source?: "text" | "tooltip" }[], title: string | null): PopupObservation {
  return {
    id: "popup:boost-unlocked", context: "BoostUnlockedPopup", kind: "informational",
    active: true, visible: true, blocking: false, dismissable: true, autoDismissible: true,
    autoDismissReason: null, contentStatus: "captured", status: "ok", title,
    note: "BoostUnlockedPopup.lua. OnClose() is the native Continue-button/ESC/Return path.",
    content: { fields: fields.map(f => ({ ...f, source: f.source ?? "text" })), truncated: false, unreadable: [] },
  };
}

test("a dismissed popup delivers its rendered message, not the adapter's engineering notes", () => {
  const digest = popupDigest(observed([
    { control: "Controls.HeaderLabel", text: "INSPIRATION!" },
    { control: "Controls.BoostDescString", text: "Your progress toward [ICON_Civic]Foreign Trade has advanced considerably." },
    { control: "root/1/1/1/1/3/3", text: "[ICON_CivicBoosted]" },
    { control: "root/1/1/1/1/3/4", text: "BOOSTED" },
    { control: "root/1/1/1/1/4", text: "Continue" },
  ], "INSPIRATION!"), 7);
  expect(digest).toEqual({
    turn: 7, id: "boost-unlocked", title: "INSPIRATION!",
    text: "Your progress toward Foreign Trade has advanced considerably.",
  });
  // The things that were being reprinted on every popup the game raised.
  const wire = JSON.stringify(digest);
  for (const gone of ["BoostUnlockedPopup", "DequeuePopup", "root/1", "autoDismissible", "contentStatus", "Continue", "ICON_"]) {
    expect(wire).not.toContain(gone);
  }
});

test("a popup carrying nothing but chrome is not delivered at all", () => {
  expect(popupDigest(observed([{ control: "root/1/2", text: "Close" }], null), 3)).toBeNull();
});

test("layout markup is removed from the message but the words around it survive", () => {
  const digest = popupDigest(observed([
    { control: "Controls.Body", text: "[SIZE_16]4000 BC    \|    Turn 1[NEWLINE]+1 [ICON_Glory]Era Score[SIZE_12]" },
  ], null), 1);
  expect(digest!.text).toBe("4000 BC | Turn 1 +1 Era Score");
});

test("a truncated capture says so, because the message it carries is incomplete", () => {
  const popup = observed([{ control: "Controls.Body", text: "partial" }], "T");
  popup.content!.truncated = true;
  expect(popupDigest(popup, 2)!.truncated).toBe(true);
});
