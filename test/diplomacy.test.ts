import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

// lua/diplomacy.lua resolves the decision helpers from lua/decisions.lua at call time and publishes
// its schema at load time, so the harness loads it the way src/bridge.ts does: diplomacy immediately
// before decisions.
const paths = ["test/lua/shim.lua", "test/lua/fixture.lua", "lua/common.lua", "lua/state.lua",
  "lua/diplomacy.lua", "lua/decisions.lua"];
const sources = await Promise.all(paths.map(path => Bun.file(path).text()));

// The shared fixture models Lua-visible objects only; it cannot simulate native access violations.
function scenario(code: string): void {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  try {
    for (const source of [...sources, `AstraCiv.session = 'test'; STUB_INSTALL('default'); AstraCiv.begin(); ${code}`]) {
      if (lauxlib.luaL_dostring(state, to_luastring(source)) !== lua.LUA_OK) {
        throw new Error(to_jsstring(lua.lua_tostring(state, -1)));
      }
    }
  } finally {
    lua.lua_close(state);
  }
}

test("diplomacy module remains valid Civ Lua 5.1", () => {
  expect(parse(sources[4]!, { luaVersion: "5.1" }).type).toBe("Chunk");
});

/**
 * Session harness. The statement and selection rows are the native DiplomacyStatements /
 * DiplomacySelections query results, and the manager stubs record every request so a test can prove
 * which native call was made and which was not.
 */
const SESSION_STUBS = `
local A = AstraCiv
STUB_RESPONSES, STUB_STATEMENTS, STUB_SESSIONS, STUB_CLOSED = {}, {}, {}, nil
local function ctxNow() return {pid = 0, player = Players[0], blockers = {}, blockersKnown = true, turn = STUB_TURN} end
local function installSession()
  STUB_KEY_NAMES = {[900] = 'FIRST_MEET_NEAR_RECIPIENT', [901] = 'NONE', [902] = 'ANY', [903] = 'GREETING'}
  DiplomacyManager = {
    GetKeyName = function(value) return STUB_KEY_NAMES[value] end,
    FindTextKey = function(text) return text end,
    FindReasonTextKey = function() return nil end,
    FindReasonAgendaTextKey = function() return nil end,
    HasQueuedSession = function() return false end,
    FindOpenSessionID = function(_, other) if other == 2 then return 7 end return nil end,
    IsSessionIDOpen = function(session) return session == 7 end,
    GetSessionInfo = function(session) if session == 7 then return {FromPlayer = 2, ToPlayer = 0} end return nil end,
    AddResponse = function(_, _, response) STUB_RESPONSES[#STUB_RESPONSES + 1] = response; return true end,
    AddStatement = function(_, _, statement) STUB_STATEMENTS[#STUB_STATEMENTS + 1] = statement; return true end,
    CloseSession = function(session) STUB_CLOSED = session; return true end,
    RequestSession = function(_, _, statement) STUB_SESSIONS[#STUB_SESSIONS + 1] = statement; return true end,
  }
end
-- The two selection sets the native screen reads: an observed first-meet statement and the GREETING
-- list the overview and an opened conversation are built from (DiplomacyActionView.lua:784-861).
local function installSelections()
  DB = { Query = function(sql, first)
    if sql:find('from DiplomacyStatements', 1, true) then
      if first == 'FIRST_MEET_NEAR_RECIPIENT' then
        return {{StatementText = 'LOC_MEET_TEXT', Selections = 'FIRST_MEET_NEAR_RECIPIENT'}}
      elseif first == 'GREETING' then
        return {{Selections = 'GREETING'}}
      end
      return {}
    end
    if sql:find('from DiplomacySelections', 1, true) then
      if first == 'FIRST_MEET_NEAR_RECIPIENT' then
        return {
          {Key = 'CHOICE_POSITIVE', Text = 'LOC_POS', Sort = 0},
          {Key = 'CHOICE_NEGATIVE', Text = 'LOC_NEG', Sort = 1, DiplomaticActionType = 'DIPLOACTION_BLOCKED'},
          {Key = 'CHOICE_EXIT', Text = 'LOC_EXIT', Sort = 2},
        }
      elseif first == 'GREETING' then
        return {
          {Key = 'CHOICE_MAKE_PEACE', Text = 'LOC_MAKE_PEACE', Sort = 1, DiplomaticActionType = 'DIPLOACTION_PROPOSE_PEACE_DEAL'},
          {Key = 'CHOICE_DENOUNCE', Text = 'LOC_DENOUNCE', Sort = 6, DiplomaticActionType = 'DIPLOACTION_DENOUNCE'},
          {Key = 'CHOICE_DECLARE_FORMAL_WAR', Text = 'LOC_WAR', Sort = 8, DiplomaticActionType = 'DIPLOACTION_DECLARE_FORMAL_WAR'},
          {Key = 'CHOICE_MAKE_DEAL', Text = 'LOC_MAKE_DEAL', Sort = 15, DiplomaticActionType = 'DIPLOACTION_PROPOSE_TRADE'},
          {Key = 'CHOICE_VIEW_DEAL', Text = 'LOC_VIEW_DEAL', Sort = 16, DiplomaticActionType = 'DIPLOACTION_VIEW_TRADE'},
          {Key = 'CHOICE_EXIT', Text = 'LOC_EXIT', Sort = 23},
        }
      end
      return {}
    end
    return {}
  end }
end
local function cacheStatement(statementType)
  A.diplomacyStatements[7] = {fromPlayer = 2, toPlayer = 0, statementType = statementType or 900,
    statementSubType = 901, fromPlayerMood = 902, fromMood = 902, initiator = 2}
end
local function denyBlockedAction()
  Players[0]:GetDiplomacy().IsDiplomaticActionValid = function(_, actionType)
    if actionType == 'DIPLOACTION_BLOCKED' then return false, {FailureReasons = {'LOC_BLOCKED'}} end
    return true
  end
end
Players[2].IsAlive = function() return true end
local function noSession() DiplomacyManager.FindOpenSessionID = function() return nil end end
local function allowAllActions()
  Players[0]:GetDiplomacy().IsDiplomaticActionValid = function() return true end
end
`;

/**
 * Deal harness. The deal object mirrors the DiplomacyDeal / DiplomacyDealItem surface the native
 * DiplomacyDealView reads and writes; every SendWorkingDeal action is recorded.
 */
const DEAL_STUBS = `
STUB_SENT, STUB_CLEARED, STUB_VALIDATE, STUB_COPIED, STUB_ITEMS, STUB_ITEM_SEQ = {}, false, 0, false, {}, 100
DealDirection = {OUTGOING = 1, INCOMING = 2}
DealProposalAction = {PENDING = 0, PROPOSED = 1, ACCEPTED = 2, ADJUSTED = 3, REJECTED = 4,
  REJECTED_PERMANENT = 5, EQUALIZE = 6, EQUALIZE_FAILED = 7, INSPECT = 8, CLOSED = 9, DEMANDED = 10}
DealItemTypes = {GOLD = 1, RESOURCES = 2, AGREEMENTS = 3, CITIES = 4, GREATWORK = 5, CAPTIVE = 6, FAVOR = 7}
DealAgreementTypes = {MAKE_PEACE = 11, OPEN_BORDERS = 12, RESEARCH_AGREEMENT = 13, ALLIANCE = 14, JOINT_WAR = 15, THIRD_PARTY_WAR = 16}
DealValidationResult = {VALID = 1, MISSING_DEPENDENCY = 2}
DealItemSubTypes = {NONE = 0}
local function makeItem(spec)
  local item = {id = 1, type = DealItemTypes.GOLD, subType = 0, valueType = 0, from = 0, to = 2,
    amount = 1, maxAmount = 5, duration = 0, locked = false, unacceptable = false}
  for key, value in pairs(spec or {}) do item[key] = value end
  item.GetID = function(self) return self.id end
  item.GetType = function(self) return self.type end
  item.GetSubType = function(self) return self.subType end
  item.GetValueType = function(self) return self.valueType end
  item.GetAmount = function(self) return self.amount end
  item.GetMaxAmount = function(self) return self.maxAmount end
  item.GetDuration = function(self) return self.duration end
  item.GetFromPlayerID = function(self) return self.from end
  item.GetToPlayerID = function(self) return self.to end
  item.IsValid = function(self) return true end
  item.IsLocked = function(self) return self.locked end
  item.IsUnacceptable = function(self) return self.unacceptable end
  item.SetAmount = function(self, value) self.amount = value; return true end
  item.SetDuration = function(self, value) self.duration = value; return true end
  item.SetSubType = function(self, value) self.subType = value; return true end
  item.SetValueType = function(self, value) self.valueType = value; return true end
  item.SetLocked = function(self, value) self.locked = value; return true end
  item.GetValueTypeNameID = function() return nil end
  item.GetSubTypeNameID = function() return nil end
  item.GetParameterValue = function() return nil end
  return item
end
local function makeDeal(items)
  local deal = {items = items or {}}
  deal.GetItemCount = function(self) return #self.items end
  deal.Items = function(self) local index = 0; return function() index = index + 1; return self.items[index] end end
  deal.IsValid = function() return true end
  deal.HasUnacceptableItems = function(self)
    for _, item in ipairs(self.items) do if item:IsUnacceptable() then return true end end
    return false
  end
  deal.Validate = function() STUB_VALIDATE = STUB_VALIDATE + 1; return DealValidationResult.VALID end
  deal.FindItemByID = function(self, id)
    for _, item in ipairs(self.items) do if item.id == id then return item end end
    return nil
  end
  deal.RemoveItemByID = function(self, id)
    for index, item in ipairs(self.items) do
      if item.id == id then table.remove(self.items, index); return true end
    end
    return false
  end
  deal.AddItemOfType = function(self, itemType, fromId, toId, subType, valueType)
    -- Real item ids are unique even though the manager re-creates an item on every edit.
    STUB_ITEM_SEQ = STUB_ITEM_SEQ + 1
    local item = makeItem({id = STUB_ITEM_SEQ, type = itemType, from = fromId, subType = subType or 0,
      valueType = valueType or 0})
    self.items[#self.items + 1] = item
    return item
  end
  return deal
end
local function installDeal(deal, options)
  options = options or {}
  STUB_SENT, STUB_VALIDATE = {}, 0
  STUB_DEAL = deal or makeDeal({})
  DealManager = {
    GetWorkingDeal = function(direction)
      if direction == DealDirection.OUTGOING then return STUB_DEAL end
      return options.incoming or nil
    end,
    HasPendingDeal = function() return options.pending == true end,
    AreWorkingDealsEqual = function() return options.equal == true end,
    ClearWorkingDeal = function() STUB_CLEARED = true; STUB_DEAL.items = {}; return true end,
    CopyIncomingToOutgoingWorkingDeal = function() STUB_COPIED = true; return true end,
    SendWorkingDeal = function(action) STUB_SENT[#STUB_SENT + 1] = action; return true end,
    GetPossibleDealItems = function(_, _, itemType)
      for _, entry in ipairs(options.offered or {}) do
        if entry.itemType == itemType then return entry.entries end
      end
      return {}
    end,
  }
end
`;

test("an open session answers with engine response names and closes through CloseSession", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    local record = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    assert(record.sessionId == 7 and record.otherPlayerId == 2 and record.sessionOpen == true)
    assert(record.statementType == 'FIRST_MEET_NEAR_RECIPIENT' and record.heardText == 'LOC_MEET_TEXT')
    assert(record.selectionSource == 'native_diplomacy_tables')
    assert(record.options[1].choice == 'CHOICE_POSITIVE' and record.options[1].available == true)
    assert(record.options[2].choice == 'CHOICE_NEGATIVE' and record.options[2].available == false)
    assert(tostring(record.options[2].reasons[1]) == 'LOC_BLOCKED')
    assert(record.options[3].choice == 'CHOICE_EXIT')
    local ctx = ctxNow()
    local answered = A.diplomacyAction(ctx, {operation='response', sessionId=7, key='CHOICE_POSITIVE'}, record)
    assert(answered.accepted and answered.status == 'submitted' and #STUB_RESPONSES == 1)
    assert(STUB_RESPONSES[1] == 'POSITIVE', 'the UI key must be mapped to the engine response name')
    assert(answered.observed.sessionOpen == true and answered.observed.sessionId == 7)
    A.diplomacyStatements = {}
    local stopped = A.diplomacyAction(ctx, {operation='response', sessionId=7, playerId=2, key='CHOICE_STOP_ASKING'})
    assert(stopped.accepted and STUB_RESPONSES[2] == 'REJECTED_PERMANENT')
    local closed = A.diplomacyAction(ctx, {operation='response', sessionId=7, key='CHOICE_EXIT'}, record)
    assert(closed.accepted and STUB_CLOSED == 7 and #STUB_RESPONSES == 2, 'CHOICE_EXIT must close, never answer')
  `);
});

test("a selection the engine refuses is never submitted", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    local record = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    local refused = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, playerId=2, key='CHOICE_NEGATIVE'})
    assert(not refused.accepted and refused.status == 'illegal' and #STUB_RESPONSES == 0)
    assert(tostring(refused.reasons[1]):find('LOC_BLOCKED', 1, true) ~= nil)
    local ok = pcall(A.diplomacyAction, ctxNow(), {operation='response', sessionId=7, key='CHOICE_NEGATIVE'}, record)
    assert(not ok and #STUB_RESPONSES == 0, 'the id path must reject an unavailable selection before submission')
  `);
});

test("a cold statement cache allows only the engine response names and refuses unchecked statements", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections()
    local answered = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, playerId=2, key='POSITIVE'})
    assert(answered.accepted and answered.selectionValidated == false and STUB_RESPONSES[1] == 'POSITIVE')
    local unchecked = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, playerId=2, key='CHOICE_DENOUNCE'})
    assert(not unchecked.accepted and unchecked.status == 'unknown' and #STUB_RESPONSES == 1)
    local statement = A.diplomacyAction(ctxNow(), {operation='statement', sessionId=7, playerId=2, key='DECLARE_FORMAL_WAR'})
    assert(not statement.accepted and statement.status == 'unknown' and #STUB_STATEMENTS == 0)
  `);
});

test("statements use the native statement name and stale identities never reach the engine", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); denyBlockedAction()
    -- A session the local player started answers from the GREETING statement (DiplomacyActionView.lua:836-861).
    cacheStatement(903)
    local record = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    assert(record.statementType == 'GREETING' and record.selectionSource == 'native_diplomacy_tables')
    local bare = A.diplomacyAction(ctxNow(), {operation='statement', sessionId=7, playerId=2, key='DECLARE_FORMAL_WAR'})
    assert(bare.accepted and STUB_STATEMENTS[1] == 'DECLARE_FORMAL_WAR')
    local prefixed = A.diplomacyAction(ctxNow(), {operation='statement', sessionId=7, playerId=2, key='CHOICE_DENOUNCE'})
    assert(prefixed.accepted and STUB_STATEMENTS[2] == 'DENOUNCE', 'the CHOICE_ prefix is the UI spelling of the same statement')
    local unoffered = A.diplomacyAction(ctxNow(), {operation='statement', sessionId=7, playerId=2, key='DECLARE_HOLY_WAR'})
    assert(not unoffered.accepted and #STUB_STATEMENTS == 2, 'a statement this session does not offer is refused')
    DiplomacyManager.IsSessionIDOpen = function() return false end
    local stale = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, key='CHOICE_MAKE_PEACE'}, record)
    assert(not stale.accepted and stale.status == 'stale' and #STUB_RESPONSES == 0)
    DiplomacyManager.IsSessionIDOpen = function() return true end
    DiplomacyManager.GetSessionInfo = function() return {FromPlayer = 0, ToPlayer = 1} end
    local wrongPair = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, playerId=2, key='CHOICE_MAKE_PEACE'})
    assert(not wrongPair.accepted and wrongPair.status == 'stale' and #STUB_RESPONSES == 0)
    local ok, err = pcall(A.diplomacyAction, ctxNow(), {operation='response', sessionId=7, playerId=9, key='CHOICE_POSITIVE'})
    assert(not ok and tostring(err):find('Unknown player id', 1, true) ~= nil)
  `);
});

test("a session operation derives its counterpart from the open session", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    -- playerId omitted: the open session is the identity (FindOpenSessionID/GetSessionInfo), and
    -- liveSession re-verifies that it connects the local player with the derived counterpart.
    local answered = A.diplomacyAction(ctxNow(), {operation='response', sessionId=7, key='CHOICE_POSITIVE'})
    assert(answered.accepted and answered.otherPlayerId == 2 and STUB_RESPONSES[1] == 'POSITIVE')
    local closed = A.diplomacyAction(ctxNow(), {operation='close', sessionId=7})
    assert(closed.accepted and STUB_CLOSED == 7 and closed.otherPlayerId == 2)
    DiplomacyManager.IsSessionIDOpen = function() return false end
    local stale = A.diplomacyAction(ctxNow(), {operation='close', sessionId=99})
    assert(not stale.accepted and stale.status == 'stale' and STUB_CLOSED == 7)
    local ok, err = pcall(A.diplomacyAction, ctxNow(), {operation='close', sessionId=7, playerId=3})
    assert(not ok and tostring(err):find('Unknown player id', 1, true) ~= nil,
      'an explicit playerId is still validated even when a session could name a counterpart')
  `);
});

test("a queued session is reported even when other diplomacy rows exist", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); denyBlockedAction(); noSession()
    DiplomacyManager.HasQueuedSession = function() return true end
    local all = A.decisions({kind='diplomacy', detail='full'}).decisions
    assert(#all == 2, 'the openings row and the queued row are both reported')
    local queued = all[1].id == 'test:decision:diplomacy:queued' and all[1] or all[2]
    assert(queued.id == 'test:decision:diplomacy:queued' and queued.uiBlocking == true)
    assert(tostring(queued.label):find('queued', 1, true) ~= nil)
  `);
});

test("open uses the native GREETING selections, the RequestSession table and its gates", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); denyBlockedAction(); noSession()
    local summary = A.decisions({kind='diplomacy'}).decisions[1]
    assert(summary.optionCount > 0 and summary.availableOptionCount == A.null,
      'unchecked diplomatic openings must not be summarized as zero legal choices')
    -- A list carries the keys: labels, statements and war types are ruleset data, identical for
    -- every counterpart, and civ.probe publishes them once.
    local openings = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    assert(openings.operations[1] == 'open' and openings.otherPlayerId == 2)
    assert(openings.options == nil, 'a list must not repeat one ruleset table once per player')
    assert(openings.choices[1] == 'CHOICE_MAKE_PEACE' and openings.choices[2] == 'CHOICE_DENOUNCE')
    for _, choice in ipairs(openings.choices) do
      assert(choice ~= 'CHOICE_VIEW_DEAL', 'a key this bridge cannot open is counted, not listed')
    end
    assert(openings.unopenableCount == 1, 'the keys left out are still reported as a count')
    -- Asking about that one record is what buys the descriptions and the per-pair legality query.
    local one = A.decisions({id = openings.id}).decisions[1]
    assert(one.options[1].choice == 'CHOICE_MAKE_PEACE' and one.options[1].statement == 'MAKE_DEAL')
    assert(one.options[1].label == 'LOC_MAKE_PEACE')
    assert(one.options[2].choice == 'CHOICE_DENOUNCE' and one.options[2].available == true,
      'a single-record lookup asks the engine for this pair instead of reporting an unchecked key')
    local opened = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_DENOUNCE'})
    assert(opened.accepted and STUB_SESSIONS[1] == 'DENOUNCE')
    assert(opened.observed.otherPlayerId == 2)
    Players[0]:GetDiplomacy().IsDiplomaticActionValid = function(_, actionType)
      if actionType == 'DIPLOACTION_DENOUNCE' then return false, {FailureReasons = {'LOC_TOO_SOON'}} end
      return true
    end
    local refused = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_DENOUNCE'})
    assert(not refused.accepted and #STUB_SESSIONS == 1)
    assert(tostring(refused.reasons[1]):find('LOC_TOO_SOON', 1, true) ~= nil)
    local screenKey = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_VIEW_DEAL'})
    assert(not screenKey.accepted and #STUB_SESSIONS == 1)
    DiplomacyManager.FindOpenSessionID = function() return 7 end
    local second = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_MAKE_PEACE'})
    assert(not second.accepted and second.status == 'illegal' and #STUB_SESSIONS == 1)
  `);
});

test("MAKE_DEAL clears the draft and MAKE_PEACE stages the locked agreement first", () => {
  scenario(`${SESSION_STUBS}${DEAL_STUBS}
    installSession(); installSelections(); denyBlockedAction(); noSession()
    installDeal(makeDeal({}), {pending = false})
    local made = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_MAKE_DEAL'})
    assert(made.accepted and STUB_CLEARED == true and STUB_SESSIONS[1] == 'MAKE_DEAL')
    STUB_CLEARED, STUB_SESSIONS = false, {}
    local peace = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_MAKE_PEACE'})
    assert(peace.accepted and STUB_SESSIONS[1] == 'MAKE_DEAL' and STUB_CLEARED == true)
    assert(#STUB_DEAL.items == 1 and STUB_DEAL.items[1].type == DealItemTypes.AGREEMENTS)
    assert(STUB_DEAL.items[1].subType == DealAgreementTypes.MAKE_PEACE and STUB_DEAL.items[1].locked == true)
    assert(STUB_VALIDATE == 1, 'the native path validates the staged peace draft')
    STUB_CLEARED, STUB_SESSIONS = false, {}
    installDeal(makeDeal({}), {pending = true})
    local pending = A.diplomacyAction(ctxNow(), {operation='open', playerId=2, key='CHOICE_MAKE_DEAL'})
    assert(pending.accepted and STUB_CLEARED == false and STUB_SESSIONS[1] == 'MAKE_DEAL')
    assert(tostring(pending.skippedClear):find('pending', 1, true) ~= nil)
  `);
});

test("deal draft edits need an entry the engine offers and never invent amounts", () => {
  scenario(`${SESSION_STUBS}${DEAL_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    local resource = makeItem({id = 4, type = DealItemTypes.RESOURCES, valueType = 20, from = 0})
    installDeal(makeDeal({resource}), {offered = {
      {itemType = DealItemTypes.RESOURCES, entries = {{ForType = 20, MaxAmount = 4, Duration = 30, IsValid = true,
        ValidationResult = DealValidationResult.VALID}}},
      {itemType = DealItemTypes.GOLD, entries = {{ForType = 0, MaxAmount = 120, Duration = 0, IsValid = true,
        ValidationResult = DealValidationResult.VALID}}},
    }})
    local added = A.diplomacyAction(ctxNow(), {operation='deal_item_add', playerId=2, itemType='RESOURCES', valueType=20})
    assert(added.accepted and #STUB_DEAL.items == 2)
    assert(added.item.typeId == DealItemTypes.RESOURCES and added.item.valueType == 20)
    assert(added.item.amount == 1 and added.item.duration == 30, 'the native resource click adds one for 30 turns')
    local unoffered = A.diplomacyAction(ctxNow(), {operation='deal_item_add', playerId=2, itemType='RESOURCES', valueType=99})
    assert(not unoffered.accepted and #STUB_DEAL.items == 2)
    local gold = A.diplomacyAction(ctxNow(), {operation='deal_item_add', playerId=2, itemType='GOLD'})
    assert(not gold.accepted and #STUB_DEAL.items == 2, 'no gold amount may be invented')
    local tooMuch = A.diplomacyAction(ctxNow(), {operation='deal_item_set', playerId=2, itemId=4, amount=9})
    assert(not tooMuch.accepted and STUB_DEAL.items[1].amount == 1)
    local edited = A.diplomacyAction(ctxNow(), {operation='deal_item_set', playerId=2, itemId=4, amount=4})
    assert(edited.accepted and #STUB_DEAL.items == 2, 'the native editor removes and re-adds the item')
    assert(edited.item.amount == 4 and edited.item.duration == 0 and edited.item.valueType == 20)
    local gone = A.diplomacyAction(ctxNow(), {operation='deal_item_remove', playerId=2, itemId=4})
    assert(not gone.accepted and tostring(gone.reasons[1]):find('not in the current working deal', 1, true) ~= nil)
    local removed = A.diplomacyAction(ctxNow(), {operation='deal_item_remove', playerId=2, itemId=edited.item.itemId})
    assert(removed.accepted and #STUB_DEAL.items == 1)
    local locked = makeItem({id = 9, type = DealItemTypes.AGREEMENTS, subType = DealAgreementTypes.MAKE_PEACE, locked = true})
    STUB_DEAL.items = {locked}
    local keepPeace = A.diplomacyAction(ctxNow(), {operation='deal_item_remove', playerId=2, itemId=9})
    assert(not keepPeace.accepted and #STUB_DEAL.items == 1)
    local staleItem = A.diplomacyAction(ctxNow(), {operation='deal_item_remove', playerId=2, itemId=44})
    assert(not staleItem.accepted and tostring(staleItem.reasons[1]):find('not in the current working deal', 1, true) ~= nil)
  `);
});

test("deal requests follow the native gates and balance never accepts or spends", () => {
  scenario(`${SESSION_STUBS}${DEAL_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    local peace = makeItem({id = 1, type = DealItemTypes.AGREEMENTS, subType = DealAgreementTypes.MAKE_PEACE, locked = true})
    installDeal(makeDeal({peace}), {pending = false, equal = false})
    local balanced = A.diplomacyAction(ctxNow(), {operation='deal_balance', playerId=2})
    assert(balanced.accepted and #STUB_SENT == 1 and STUB_SENT[1] == DealProposalAction.EQUALIZE)
    assert(balanced.dealAction == 'EQUALIZE')
    local notEqual = A.diplomacyAction(ctxNow(), {operation='deal_accept', playerId=2})
    assert(not notEqual.accepted and #STUB_SENT == 1, 'accept needs AreWorkingDealsEqual')
    assert(tostring(notEqual.reasons[1]):find('not equal', 1, true) ~= nil)
    installDeal(makeDeal({peace}), {pending = false, equal = true})
    local accepted = A.diplomacyAction(ctxNow(), {operation='deal_accept', playerId=2})
    assert(accepted.accepted and #STUB_SENT == 1 and STUB_SENT[1] == DealProposalAction.ACCEPTED)
    installDeal(makeDeal({peace}), {pending = true, equal = true})
    local pending = A.diplomacyAction(ctxNow(), {operation='deal_propose', playerId=2})
    assert(not pending.accepted and #STUB_SENT == 0, 'a pending proposal blocks another send')
    installDeal(makeDeal({}), {pending = false})
    local empty = A.diplomacyAction(ctxNow(), {operation='deal_propose', playerId=2})
    assert(not empty.accepted and #STUB_SENT == 0 and STUB_VALIDATE == 0, 'an empty draft is never sent')
    local cancel = A.diplomacyAction(ctxNow(), {operation='deal_close', playerId=2})
    assert(not cancel.accepted and #STUB_SENT == 0, 'CLOSED is only for a pending deal')
    installDeal(makeDeal({peace}), {pending = false})
    local stopAsking = A.diplomacyAction(ctxNow(), {operation='deal_reject_permanent', playerId=2})
    assert(not stopAsking.accepted and #STUB_SENT == 0)
    assert(tostring(stopAsking.reasons[1]):find('unacceptable', 1, true) ~= nil,
      'Stop Asking needs an unacceptable item the local player offered')
  `);
});

test("a throwing native mutation is unknown and stops the sequence", () => {
  scenario(`${SESSION_STUBS}${DEAL_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    local peace = makeItem({id = 1, type = DealItemTypes.AGREEMENTS, subType = DealAgreementTypes.MAKE_PEACE, locked = true})
    installDeal(makeDeal({peace}), {pending = false, equal = false})
    -- The engine throws after the request was issued: the outcome is unknown, never submitted.
    DealManager.SendWorkingDeal = function() error('engine lost the acknowledgement') end
    local balanced = A.diplomacyAction(ctxNow(), {operation='deal_balance', playerId=2})
    assert(not balanced.accepted and balanced.status == 'unknown' and #STUB_SENT == 0)
    assert(tostring(balanced.reasons[1]):find('NOT replayed', 1, true) ~= nil)
    assert(balanced.completed == false)
    -- A throw inside a multi-step item edit stops where it happened instead of replaying or finishing.
    installDeal(makeDeal({makeItem({id = 4, type = DealItemTypes.RESOURCES, valueType = 20, from = 0})}), {offered = {
      {itemType = DealItemTypes.RESOURCES, entries = {{ForType = 20, MaxAmount = 4, Duration = 30, IsValid = true,
        ValidationResult = DealValidationResult.VALID}}},
    }})
    local originalAdd = STUB_DEAL.AddItemOfType
    STUB_DEAL.AddItemOfType = function(self, ...)
      local item = originalAdd(self, ...)
      item.SetAmount = function() error('setter lost its acknowledgement') end
      return item
    end
    local edited = A.diplomacyAction(ctxNow(), {operation='deal_item_set', playerId=2, itemId=4, amount=3})
    assert(not edited.accepted and edited.status == 'unknown')
    assert(edited.stoppedAt == 4, 'the sequence stops at the throwing step')
    assert(#STUB_DEAL.items == 1 and STUB_DEAL.items[1].amount == 1, 'nothing after the throw was sent')
  `);
});

test("deal state degrades honestly when the managers are unavailable", () => {
  scenario(`${SESSION_STUBS}${DEAL_STUBS}
    installSession(); installSelections()
    DealManager = nil
    local record = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    assert(record.sessionId == 7 and record.deal.read.manager == false)
    assert(record.deal.pending == AstraCiv.null and tostring(record.deal.note):find('unavailable', 1, true) ~= nil)
    assert(A.diagnostics.diplomacy ~= nil and A.diagnostics.diplomacy.DealManager ~= nil)
    local refused = A.diplomacyAction(ctxNow(), {operation='deal_propose', playerId=2})
    assert(not refused.accepted and refused.status == 'illegal' and #STUB_SENT == 0)
    DiplomacyManager = nil
    local degraded = A.decisions({kind='diplomacy'})
    assert(degraded.total == 0)
    assert(A.diagnostics.diplomacy.DiplomacyManager ~= nil)
  `);
});

// The failure this prevents: a leader screen holds the turn, the engine refuses to enumerate
// blockers while it is up, and turnState reported `blockers: null` - which a wait loop reads as
// "nothing is wrong". In a real run that cost a 120s execution timeout, a destroyed Python
// namespace and a screenshot before the model worked out what was happening.
test("a live leader screen is named in turnState, not left as a silent null", () => {
  scenario(`${SESSION_STUBS}
    installSession(); installSelections(); cacheStatement(); denyBlockedAction()
    STUB_ACTIVE = false
    local held = A.turnState()
    assert(held.blockers == A.null, 'the engine still will not enumerate blockers here')
    assert(type(held.waitingOn) == 'table', 'turnState must say what is holding the turn')
    assert(held.waitingOn.kind == 'diplomacy' and held.waitingOn.sessionId == 7)

    -- A queued session that has not opened yet is a hold too.
    A.diplomacyStatements[7] = nil
    DiplomacyManager.HasQueuedSession = function() return true end
    local queued = A.turnState()
    assert(queued.waitingOn.kind == 'diplomacy' and queued.waitingOn.queued == true)

    -- Ordinary between-turns processing is not a hold, and an active turn never pays for the scan.
    DiplomacyManager.HasQueuedSession = function() return false end
    assert(A.turnState().waitingOn == A.null, 'AI turns processing is not a screen waiting on you')
    STUB_ACTIVE = true
    cacheStatement()
    local active = A.turnState()
    assert(active.waitingOn == A.null and active.blockers ~= A.null,
      'with blockers readable the blocker list is the answer and no session scan is run')
  `);
});

test("a blocker reports one localized summary rather than the same string twice", () => {
  scenario(`${SESSION_STUBS}
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_UNITS}
    local blocker = A.turnState().blockers[1]
    assert(blocker.summary ~= nil and blocker.summaryKey == nil,
      'summaryKey was a byte-identical twin of summary in every record that carried both')
  `);
});
