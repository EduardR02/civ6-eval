import { expect, test } from "bun:test";
import { dismissPopup, observePopups } from "./popups.ts";

test("popup discovery does not advertise a missing native close handler", async () => {
  const observations = await observePopups(async () => ({ visible: true, active: true, closeable: false, title: "Eruption" }), { id: "popup:natural-disaster" });
  expect(observations).toMatchObject([{ id: "popup:natural-disaster", visible: true, dismissable: false, title: "Eruption" }]);
});

test("inactive popup dismissal does not invoke its native handler", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:natural-disaster", async () => {
    if (++calls > 1) throw new Error("inactive screen must not receive input");
    return { visible: false, active: false };
  });
  expect(result.dismissed).toBe(false);
  expect(result.status).toBe("ok");
  expect(calls).toBe(1);
});

test("an informational close cannot claim dismissal while a queued successor remains visible", async () => {
  const replies = [{ active: true, visible: true }, { closed: true }, { active: true, visible: true }];
  const result = await dismissPopup("popup:natural-disaster", async () => replies.shift());
  expect(result.dismissed).toBe(false);
});

test("native close failure is not converted into a successful dismissal or retried", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:natural-disaster", async () => {
    if (++calls === 1) return { visible: true, active: true };
    throw new Error("acknowledgement lost");
  });
  expect(result.status).toBe("error");
  expect(result.dismissed).toBe(false);
  expect(calls).toBe(2);
});

test("terminal game-over screens cannot be dismissed through a cosmetic adapter", async () => {
  let calls = 0;
  const result = await dismissPopup("popup:end-game-menu", async () => { calls++; throw new Error("must not execute"); });
  expect(result.status).toBe("not-dismissable");
  expect(result.dismissed).toBe(false);
  expect(calls).toBe(0);
});
