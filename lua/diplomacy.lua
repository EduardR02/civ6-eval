-- ---------------------------------------------------------------------------
-- Diplomacy: sessions, first contact, and the native deal negotiation surface.
--
-- Native sources (installed game, Gathering Storm ruleset):
--   Base/Assets/UI/DiplomacyActionView.lua
--     :297-306  ValidateActiveSession - IsSessionIDOpen is the native liveness test, not a
--               queued-request acknowledgement.
--     :357-395  IsWarChoice/GetWarType/GetGoldCost - the war and cost annotations the native
--               overview list attaches to a CHOICE_ key.
--     :407-492  OnSelectInitialDiplomacyStatement - the overview key -> RequestSession table;
--               CHOICE_MAKE_DEAL/CHOICE_MAKE_DEMAND clear the working deal first, and peace
--               additionally stages a locked MAKE_PEACE agreement before opening MAKE_DEAL.
--     :494-559  OnSelectConversationDiplomacyStatement - in-session key -> AddStatement for
--               MAKE_PEACE/MAKE_DEAL/MAKE_DEMAND/war declarations, AddResponse otherwise, and
--               CHOICE_EXIT -> ExitConversationMode -> CloseSession.
--     :566-650  ApplyStatement - leader text comes from DiplomacyManager.FindTextKey on the
--               DiplomacyStatements.StatementText key; reason text from FindReasonTextKey.
--     :784-861  AddStatmentOptions - the initial option list is the GREETING selections for the
--               local leader, Initiator=HUMAN, filtered by IsDiplomaticActionValid.
--     :2464-2530 HasNextQueuedSession / OnDiplomacySessionClosed.
--     :2545-2661 MakeDeal_ApplyStatement / MakeDeal_TestValid / MakeDemand_ApplyStatement -
--               deal statements carry DealAction/RespondingToDealAction; the deal itself is
--               answered through DealManager, not through session responses.
--     :2745-2823 OnDiplomacyStatement - sessions and statements arrive on Events.DiplomacyStatement.
--   Base/Assets/UI/DiplomacyStatementSupport.lua
--     :39-102   DiplomacyStatements + DiplomacySelections lookup ladder (Leader/Mood 'ANY').
--     :151-201  DiplomacySupport_RemoveInvalidSelections - IsDiplomaticActionValid gate; an
--               unavailable selection is dropped unless the engine returned FailureReasons, in
--               which case the native screen keeps it visible but disabled.
--   Base/Assets/UI/DiplomacyDealView.lua (base) and
--   DLC/Expansion2/UI/Replacements/DiplomacyDealView.lua + DiplomacyDealView_Expansion2.lua
--   (the installed ruleset replaces the base file and then overrides parts of it):
--     :144-167  ProposeWorkingDeal / RequestEqualizeWorkingDeal - both are no-ops while
--               HasPendingDeal(local, other) is true; EQUALIZE is the native "make this deal
--               more equitable" request and edits the working draft only.
--     :420-478  UpdateDealStatus - Validate() != DealValidationResult.VALID disables the action
--               buttons; EqualizeDeal is hidden for a demand.
--     :526-586  OnProposeOrAcceptDeal - ACCEPTED only when AreWorkingDealsEqual is true,
--               otherwise ADJUSTED (a counter-offer); PENDING/REJECTED/EQUALIZE_FAILED propose.
--     :589-655  OnRefuseDeal - REJECTED / REJECTED_PERMANENT (an unacceptable item offered by
--               the local player) / CLOSED (cancelling a pending deal), then CloseSession.
--     :1279-1334 OnClickAvailableBasic / OnClickAvailableResource - AddItemOfType then
--               SetValueType/SetAmount/SetDuration; an item that fails IsValid is removed again.
--     :1356-1427 OnClickAvailableAgreement / OnSelectAgreementOption - SetSubType/SetDuration,
--               SetValueType for the agreements that carry a value, SetParameterValue("WarType").
--     :1539-1610 OnClickAvailableGreatWork/Captive/City - AddItemOfType incl. the five-argument
--               CITIES form (type, from, other, subType, valueType) and the value-type setters.
--     Exp2      OnClickAvailableOneTimeFavor - DealItemTypes.FAVOR with SetDuration(0)+SetAmount.
--     :1611-1655 OnRemoveDealItem / OnConfirmSetDealItemUnacceptable - a locked item cannot be
--               removed; Stop Asking is SetUnacceptableItemByID + SendWorkingDeal(INSPECT).
--     :1670-1710 OnValueEditButton - an amount edit clips to GetMaxAmount and is applied by
--               removing and re-adding the item (the deal manager does not update in place).
--     :1711-2050 PopulateAvailable* - available lists are DealManager.GetPossibleDealItems
--               entries with ForType/SubType/ForTypeName/SubTypeName/Duration/MaxAmount/IsValid
--               and ValidationResult; the value list for research agreement/alliance/joint war/
--               third party war is the same call with the agreement type added.
--   Base/Assets/UI/DiplomacyRibbon.lua :60-67 - a leader is only openable when HasMet is true.
--   Civ VI Modding Companion 2.0 - Objects.csv - DealManager/DiplomacyManager/DiplomacyDeal/
--     DiplomacyDealItem signatures and the gameplay/UI availability of each entry point
--     (DealManager is listed for both contexts; DiplomacyManager is a UI-context object).
--
-- Three states are kept apart: what the engine reported (observed), what this module asked the
-- engine to queue (submitted - never a completion claim), and what the engine never answered
-- (unknown -> A.null plus an explicit reason). No request is ever replayed. Every identity the
-- caller passes is re-resolved against fresh native state before a mutation, and nothing here
-- evaluates a deal, picks a response, or accepts on the caller's behalf.
-- ---------------------------------------------------------------------------
local A = AstraCiv

local SESSION_OPERATIONS = {'open', 'response', 'statement', 'close'}
local DEAL_OPERATIONS = {
  'deal_item_add', 'deal_item_set', 'deal_item_remove', 'deal_item_unacceptable',
  'deal_clear', 'deal_copy_incoming', 'deal_balance', 'deal_propose', 'deal_adjust', 'deal_demand',
  'deal_accept', 'deal_reject', 'deal_reject_permanent', 'deal_close',
}

local OPERATION_HELP =
  'Session: open (playerId + key from the openings record), response (sessionId + key; playerId optional, taken from the open ' ..
  'session), statement (sessionId + key; playerId optional the same way), close (sessionId; playerId optional). ' ..
  'Deal draft: deal_item_add (playerId + itemType [+ from="me"|"them" + valueType/subType/amount/duration/warType]), ' ..
  'deal_item_set (playerId + itemId [+ amount/duration/valueType]), deal_item_remove (playerId + itemId), ' ..
  'deal_item_unacceptable (playerId + itemId), deal_clear (playerId), deal_copy_incoming (playerId). ' ..
  'Deal engine requests: deal_balance (playerId; native "make this deal more equitable" - asks the engine and edits the ' ..
  'draft only, so it is NOT a commitment), deal_propose (playerId), deal_adjust (playerId), deal_demand (playerId), ' ..
  'deal_accept (playerId; only while the two working deals are equal), deal_reject (playerId), ' ..
  'deal_reject_permanent (playerId), deal_close (playerId). ' ..
  'Nothing here chooses terms, answers a statement, or spends anything, and no operation touches a deal or session you did not name. ' ..
  'Draft operations (deal_item_*, deal_clear, deal_copy_incoming) and deal_balance never commit anything; ' ..
  'deal_propose/deal_adjust/deal_demand/deal_accept/deal_reject/deal_reject_permanent/deal_close DO send a native ' ..
  'commitment request for the draft you built, so use them only when you intend that.'

local function allOperations()
  local out = A.array()
  for _, name in ipairs(SESSION_OPERATIONS) do out[#out+1] = name end
  for _, name in ipairs(DEAL_OPERATIONS) do out[#out+1] = name end
  return out
end

local function dealOnlyOperations()
  local out = A.array()
  for _, name in ipairs(DEAL_OPERATIONS) do out[#out+1] = name end
  return out
end

-- ---------------------------------------------------------------------------
-- The statement stream. Sessions and their statement variants are engine events; nothing is
-- mutated by listening. StatementType/StatementSubType are engine hashes GetKeyName decodes.
-- ---------------------------------------------------------------------------
if not A.diplomacyStatementsInitialized then
  A.diplomacyStatements = {}
  local ok = pcall(function()
    Events.DiplomacyStatement.Add(function(fromPlayer, toPlayer, variants)
      if type(variants) ~= 'table' then return end
      local sessionID = variants.SessionID
      if sessionID == nil then return end
      A.diplomacyStatements[sessionID] = {
        fromPlayer = fromPlayer, toPlayer = toPlayer,
        statementType = variants.StatementType, statementSubType = variants.StatementSubType,
        fromPlayerMood = variants.FromPlayerMood, fromMood = variants.FromMood,
        initiator = variants.Initiator,
        dealAction = variants.DealAction, respondingToDealAction = variants.RespondingToDealAction,
        responseType = variants.ResponseType, aiReason = variants.AiReason, aiModifier = variants.AiModifier,
        turn = Game.GetCurrentGameTurn(),
      }
    end)
  end)
  A.diplomacyStatementsInitialized = ok
  if not ok then A.diplomacyStatements = {} end
end

local function number(value) if type(value) == 'number' then return value end return nil end
local function text(value) if type(value) == 'string' and value ~= '' then return value end return nil end

--- Engine hash -> name, the decode the native screen performs (DiplomacyManager.GetKeyName).
local function keyName(value)
  if value == nil or value == A.null then return nil end
  if type(value) ~= 'number' then return text(value) end
  return text(A.static('diplomacy', DiplomacyManager, 'GetKeyName', value))
end

--- Leader type name of one player, or nil when PlayerConfigurations cannot answer.
local function leaderName(pid)
  local config = PlayerConfigurations and PlayerConfigurations[pid]
  if not config then return nil end
  return text(A.call('diplomacy', config, 'GetLeaderTypeName'))
end

local function playerLabel(pid)
  local config = PlayerConfigurations and PlayerConfigurations[pid]
  if config then
    local name = text(A.call('diplomacy', config, 'GetLeaderName'))
    if name then return A.loc(name) end
  end
  return 'player ' .. tostring(pid)
end

local function isHuman(pid)
  local config = PlayerConfigurations and PlayerConfigurations[pid]
  if not config then return nil end
  local human = A.call('diplomacy', config, 'IsHuman')
  if type(human) == 'boolean' then return human end
  return nil
end

--- Rows of one DiplomacySelections set. The ladder (Leader, Mood) -> (Leader, ANY) -> (ANY, Mood)
--- -> (ANY, ANY) is DiplomacySupport_GetStatementFromQuery's, and the result is the first
--- non-empty set, not a union.
local function selectionRows(selectionsKey, leaderKey, moodKey)
  for _, leader in ipairs({leaderKey, 'ANY'}) do
    for _, mood in ipairs({moodKey, 'ANY'}) do
      local rows = A.static('diplomacy', DB, 'Query',
        'SELECT Text, Tooltip, Key, Sort, DiplomaticActionType from DiplomacySelections WHERE Type = ? AND Leader = ? AND Mood = ?',
        selectionsKey, leader, mood)
      if type(rows) == 'table' and #rows > 0 then
        -- ExtractStatement sorts the selections by Sort, so the screen order (and this list) is
        -- stable even when the database returns rows in another order.
        local ordered = {}
        for index, row in ipairs(rows) do ordered[index] = row end
        table.sort(ordered, function(left, right)
          local a, b = number(left.Sort) or 0, number(right.Sort) or 0
          if a ~= b then return a < b end
          return tostring(left.Key) < tostring(right.Key)
        end)
        return ordered
      end
    end
  end
  return nil
end

--- One statement row, following the same ladder the native ExtractStatement walks. Fixed queries;
--- the statement names always come from the engine, never from a caller.
local function statementRow(statementTypeName, subTypeName, initiatorName, leaderKey, moodKey)
  for _, leader in ipairs({leaderKey, 'ANY'}) do
    for _, mood in ipairs({moodKey, 'ANY'}) do
      local rows = A.static('diplomacy', DB, 'Query',
        'SELECT StatementText, Selections, ReasonText, LeaderAnimation from DiplomacyStatements WHERE Type = ? AND SubType = ? AND Initiator = ? AND Leader = ? AND Mood = ?',
        statementTypeName, subTypeName, initiatorName, leader, mood)
      if type(rows) == 'table' then
        for _, row in ipairs(rows) do
          if row.Selections ~= nil then return row end
        end
      end
    end
  end
  return nil
end

--- IsDiplomaticActionValid for one selection, exactly as DiplomacySupport_RemoveInvalidSelections
--- calls it. checked=false means the engine did not answer, which stays unknown rather than being
--- folded into a legal/illegal verdict.
local function actionLegality(diplomacy, actionType, otherPlayerID)
  if actionType == nil then return true, nil, true end
  if diplomacy == nil or diplomacy == A.null then return false, nil, false end
  local ok, valid, results = pcall(function()
    return diplomacy:IsDiplomaticActionValid(actionType, otherPlayerID, true)
  end)
  if not ok or type(valid) ~= 'boolean' then
    A.unavailable('diplomacy', 'IsDiplomaticActionValid', ok and 'Diplomatic selection legality unknown' or valid)
    return false, nil, false
  end
  local reasons
  if not valid and type(results) == 'table' and type(results.FailureReasons) == 'table' then
    reasons = A.array()
    for _, reason in ipairs(results.FailureReasons) do reasons[#reasons+1] = A.loc(reason) end
  end
  return valid, reasons, true
end

local function statementContext(cached)
  local statementType = keyName(cached.statementType)
  if statementType == nil then return nil end
  local subType = keyName(cached.statementSubType) or 'NONE'
  local leaderKey = leaderName(cached.fromPlayer) or 'ANY'
  -- Two different native mood values, both needed and neither interchangeable: the statement row is
  -- looked up with the mood the engine derived from the statement's own player mood
  -- (DiplomacyActionView.lua:566-575 passes the result of GetStatementMood(FromPlayer, FromPlayerMood)
  -- into ExtractStatement), while the dialogue text key is resolved with the raw FromMood value
  -- (:576-579 FindTextKey(StatementText, FromPlayer, FromMood, toPlayer)).
  local moodKey = keyName(cached.fromPlayerMood) or 'ANY'
  local initiator = 'HUMAN'
  if cached.initiator ~= nil and PlayerConfigurations and PlayerConfigurations[cached.initiator] then
    initiator = A.call('diplomacy', PlayerConfigurations[cached.initiator], 'IsHuman') == true and 'HUMAN' or 'AI'
  end
  return {statementType = statementType, subType = subType, initiator = initiator,
    leaderKey = leaderKey, moodKey = moodKey}
end

--- The selectable options of one statement, in the shape the native conversation view renders.
local function statementOptions(ctx, context, otherPlayerID)
  local diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
  if diplomacy == A.null then
    A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable for native selection legality')
    return nil, 'Diplomacy manager unavailable for native selection legality'
  end
  local row = statementRow(context.statementType, context.subType, context.initiator, context.leaderKey, context.moodKey)
  if row == nil then return nil, 'No DiplomacyStatements row matched this statement in this ruleset' end
  local rows = selectionRows(row.Selections, context.leaderKey, context.moodKey)
  if rows == nil then return nil, 'No DiplomacySelections row matched this statement in this ruleset' end
  local options, hidden, legalityKnown = A.array(), 0, true
  for _, selection in ipairs(rows) do
    local available, reasons, checked = actionLegality(diplomacy, selection.DiplomaticActionType, otherPlayerID)
    if not checked then legalityKnown = false end
    if available or reasons ~= nil then
      -- Optional columns are omitted rather than nulled: a selection with no tooltip has no
      -- tooltip, and three null keys per option is most of a short answer's length.
      local tooltip = A.plainText(A.loc(selection.Tooltip))
      options[#options+1] = {
        choice = selection.Key,
        available = available,
        label = A.plainText(A.loc(selection.Text)),
        tooltip = tooltip ~= A.null and tooltip or nil,
        diplomaticAction = selection.DiplomaticActionType or nil,
        reasons = reasons or nil,
      }
    else
      -- The native screen removes an unavailable selection outright when the engine gave no
      -- reason; the count is reported so the difference from the visible list is not hidden.
      hidden = hidden + 1
    end
  end
  return options, nil, {row = row, hidden = hidden, legalityKnown = legalityKnown}
end

--- The leader text of a statement, resolved through the native FindTextKey /
--- FindReasonTextKey / FindReasonAgendaTextKey chain (DiplomacyActionView.lua:566-600).
local function statementText(cached, row)
  local heardText, heardReason = A.null, A.null
  if row == nil then return heardText, heardReason end
  local textKey = A.static('diplomacy', DiplomacyManager, 'FindTextKey',
    row.StatementText, cached.fromPlayer, cached.fromMood, cached.toPlayer)
  if type(textKey) == 'string' then heardText = A.loc(textKey) end
  if row.ReasonText ~= nil then
    local reasonKey = A.static('diplomacy', DiplomacyManager, 'FindReasonTextKey',
      row.ReasonText, cached.fromPlayer, cached.aiReason, cached.aiModifier)
    if type(reasonKey) == 'string' then
      local reasonText = tostring(A.loc(reasonKey))
      local agendaKey = A.static('diplomacy', DiplomacyManager, 'FindReasonAgendaTextKey',
        cached.fromPlayer, cached.toPlayer, cached.aiReason, cached.aiModifier)
      if type(agendaKey) == 'string' and agendaKey ~= '' then
        reasonText = reasonText .. tostring(A.loc(agendaKey))
      end
      heardReason = reasonText
    end
  end
  return heardText, heardReason
end

-- The UI selection key is not the engine response string. DiplomacyActionView maps them literally
-- (DiplomacyActionView.lua:494-559): CHOICE_POSITIVE -> "POSITIVE", CHOICE_NEGATIVE -> "NEGATIVE",
-- CHOICE_IGNORE -> "RESPONSE_IGNORE", CHOICE_STOP_ASKING -> "REJECTED_PERMANENT" (after its own
-- confirmation dialog), any other key is passed through unchanged, and CHOICE_EXIT is not a
-- response at all: the native Goodbye runs ExitConversationMode(false), which closes the session.
local RESPONSE_KEYS = {
  CHOICE_POSITIVE = 'POSITIVE', POSITIVE = 'POSITIVE',
  CHOICE_NEGATIVE = 'NEGATIVE', NEGATIVE = 'NEGATIVE',
  CHOICE_IGNORE = 'RESPONSE_IGNORE', RESPONSE_IGNORE = 'RESPONSE_IGNORE',
  CHOICE_STOP_ASKING = 'REJECTED_PERMANENT', REJECTED_PERMANENT = 'REJECTED_PERMANENT',
}

--- The engine response names a session always understands. They are the fallback surface for a
--- session whose statement has not been observed (a cold cache after a reload); an arbitrary key
--- is never forwarded.
local GENERIC_RESPONSE_KEYS = {POSITIVE = true, NEGATIVE = true, RESPONSE_IGNORE = true, REJECTED_PERMANENT = true}

-- The overview key -> engine statement table of DiplomacyActionView.lua:407-492. Keys that raise a
-- leader screen instead of starting a session (CHOICE_VIEW_*) are deliberately absent: the pending
-- deal they show is observable in the decision record, so this module does not need to raise a
-- screen, and an unsupported key is refused rather than guessed.
local OPENING_STATEMENTS = {
  CHOICE_DECLARE_SURPRISE_WAR = 'DECLARE_SURPRISE_WAR',
  CHOICE_DECLARE_FORMAL_WAR = 'DECLARE_FORMAL_WAR',
  CHOICE_DECLARE_HOLY_WAR = 'DECLARE_HOLY_WAR',
  CHOICE_DECLARE_LIBERATION_WAR = 'DECLARE_LIBERATION_WAR',
  CHOICE_DECLARE_RECONQUEST_WAR = 'DECLARE_RECONQUEST_WAR',
  CHOICE_DECLARE_PROTECTORATE_WAR = 'DECLARE_PROTECTORATE_WAR',
  CHOICE_DECLARE_COLONIAL_WAR = 'DECLARE_COLONIAL_WAR',
  CHOICE_DECLARE_TERRITORIAL_WAR = 'DECLARE_TERRITORIAL_WAR',
  CHOICE_DENOUNCE = 'DENOUNCE',
  CHOICE_DECLARE_FRIENDSHIP = 'DECLARE_FRIEND',
  CHOICE_DIPLOMATIC_DELEGATION = 'DIPLOMATIC_DELEGATION',
  CHOICE_RESIDENT_EMBASSY = 'RESIDENT_EMBASSY',
  CHOICE_OPEN_BORDERS = 'OPEN_BORDERS',
  CHOICE_MAKE_DEAL = 'MAKE_DEAL',
  CHOICE_MAKE_PEACE = 'MAKE_DEAL',
  CHOICE_MAKE_DEMAND = 'MAKE_DEMAND',
  CHOICE_DEMAND_PROMISE_DONT_SPY = 'WARNING_STOP_SPYING_ON_ME',
  CHOICE_DEMAND_PROMISE_DONT_SETTLE_TOO_NEAR = 'WARNING_DONT_SETTLE_NEAR_ME',
  CHOICE_DEMAND_PROMISE_DONT_CONVERT_CITY = 'WARNING_STOP_CONVERTING_MY_CITIES',
  CHOICE_DEMAND_PROMISE_DONT_DIG_ARTIFACTS = 'WARNING_STOP_DIGGING_UP_ARTIFACTS',
}
-- The two overview keys that only raise the pending-deal screen (DealManager.ViewPendingDeal, a
-- UI-context action) rather than opening a session; recognized so the refusal is explained.
local SCREEN_ONLY_KEYS = {CHOICE_VIEW_DEAL = true, CHOICE_VIEW_DEMAND = true}

-- The native war annotation (DiplomacyActionView.lua:357-378). Reported, never used to decide.
local WAR_CHOICES = {
  CHOICE_DECLARE_SURPRISE_WAR = 'SURPRISE_WAR',
  CHOICE_DECLARE_FORMAL_WAR = 'FORMAL_WAR',
  CHOICE_DECLARE_HOLY_WAR = 'HOLY_WAR',
  CHOICE_DECLARE_LIBERATION_WAR = 'LIBERATION_WAR',
  CHOICE_DECLARE_RECONQUEST_WAR = 'RECONQUEST_WAR',
  CHOICE_DECLARE_PROTECTORATE_WAR = 'PROTECTORATE_WAR',
  CHOICE_DECLARE_COLONIAL_WAR = 'COLONIAL_WAR',
  CHOICE_DECLARE_TERRITORIAL_WAR = 'TERRITORIAL_WAR',
}

-- ---------------------------------------------------------------------------
-- Deal working state. DealManager is present in gameplay and UI contexts (Objects.csv); every
-- read below is a query, and the only mutations are the explicit operations at the end.
-- ---------------------------------------------------------------------------
local ITEM_TYPE_ORDER = {'GOLD', 'FAVOR', 'RESOURCES', 'AGREEMENTS', 'CITIES', 'GREATWORK', 'CAPTIVE'}
-- The agreement types whose value is chosen in a second step (ShowAgreementOptionPopup).
local AGREEMENT_VALUE_TYPES = {'RESEARCH_AGREEMENT', 'ALLIANCE', 'JOINT_WAR', 'THIRD_PARTY_WAR'}
local CATALOGUE_LIMIT = 60
local VALUE_LIMIT = 24

local function namespaceId(namespace, name)
  if type(namespace) ~= 'table' then return nil end
  return number(namespace[name])
end

local function dealItemTypeId(name) return namespaceId(DealItemTypes, name) end
local function dealAgreementTypeId(name) return namespaceId(DealAgreementTypes, name) end
local function dealDirectionId(name) return namespaceId(DealDirection, name) end
local function proposalActionId(name) return namespaceId(DealProposalAction, name) end

--- One native deal item, read field by field. A field the engine refused to answer stays A.null:
--- an unreadable amount must never look like zero.
local function itemRecord(item)
  local typeId = A.call('diplomacy', item, 'GetType')
  local subTypeId = A.call('diplomacy', item, 'GetSubType')
  local record = {
    itemId = A.call('diplomacy', item, 'GetID'),
    typeId = typeId,
    type = A.enumName('DealItemTypes', DealItemTypes, typeId),
    subTypeId = subTypeId,
    subType = A.enumName('DealAgreementTypes', DealAgreementTypes, subTypeId),
    subTypeName = A.loc(A.call('diplomacy', item, 'GetSubTypeNameID')),
    valueType = A.call('diplomacy', item, 'GetValueType'),
    valueTypeName = A.loc(A.call('diplomacy', item, 'GetValueTypeNameID')),
    amount = A.call('diplomacy', item, 'GetAmount'),
    maxAmount = A.call('diplomacy', item, 'GetMaxAmount'),
    duration = A.call('diplomacy', item, 'GetDuration'),
    fromPlayerId = A.call('diplomacy', item, 'GetFromPlayerID'),
    toPlayerId = A.call('diplomacy', item, 'GetToPlayerID'),
    valid = A.call('diplomacy', item, 'IsValid'),
    locked = A.call('diplomacy', item, 'IsLocked'),
    unacceptable = A.call('diplomacy', item, 'IsUnacceptable'),
  }
  -- Only the two war agreements carry a war type; that is the only item parameter the native deal
  -- screen reads back (DiplomacyDealView.lua:568-600, :1373-1413).
  local id = number(subTypeId)
  if id ~= nil and (id == dealAgreementTypeId('JOINT_WAR') or id == dealAgreementTypeId('THIRD_PARTY_WAR')) then
    record.warType = A.call('diplomacy', item, 'GetParameterValue', 'WarType') or A.null
  end
  return record
end

--- Every item of a working deal, in engine order. itemsComplete=false means the engine iterator threw
--- after yielding some items, so the list is what was readable and not a complete inventory.
local function dealItems(deal)
  local out = A.array()
  if deal == nil or deal == A.null then return out, false end
  local ok = pcall(function()
    for item in deal:Items() do
      out[#out+1] = itemRecord(item)
    end
  end)
  if not ok then
    A.unavailable('diplomacy', 'Items', 'The deal item iterator did not run to completion')
    return out, false
  end
  return out, true
end

local function workingDeal(pid, other, directionName)
  if DealManager == nil then
    A.unavailable('diplomacy', 'DealManager', 'Deal manager is unavailable in this context')
    return nil, 'DealManager is unavailable in this context'
  end
  local direction = dealDirectionId(directionName)
  if direction == nil then
    A.unavailable('diplomacy', 'DealDirection', 'DealDirection.' .. directionName .. ' is unavailable in this ruleset')
    return nil, 'DealDirection is unavailable in this ruleset'
  end
  local deal = A.static('diplomacy', DealManager, 'GetWorkingDeal', direction, pid, other)
  if deal == A.null then return nil, 'No ' .. directionName .. ' working deal exists for this pair' end
  return deal, nil
end

--- One available-item entry as the native panels read it (PopulateAvailable*).
local function availableEntry(entry)
  local record = {
    forType = number(entry.ForType) or A.null,
    forTypeName = A.loc(entry.ForTypeName),
    subTypeId = number(entry.SubType) or A.null,
    subTypeName = A.loc(entry.SubTypeName),
    duration = number(entry.Duration) or A.null,
    maxAmount = number(entry.MaxAmount) or A.null,
    valid = entry.IsValid == true,
    validation = A.enumName('DealValidationResult', DealValidationResult, entry.ValidationResult),
  }
  local parameters = entry.Parameters
  if type(parameters) == 'table' then
    local copy = {}
    for key, value in pairs(parameters) do
      if type(value) == 'string' or type(value) == 'number' then copy[key] = value end
    end
    record.parameters = copy
  end
  return record
end

local function possibleItems(fromId, toId, itemTypeId, deal, agreementTypeId)
  if agreementTypeId ~= nil then
    return A.static('diplomacy', DealManager, 'GetPossibleDealItems', fromId, toId, itemTypeId, agreementTypeId, deal)
  end
  return A.static('diplomacy', DealManager, 'GetPossibleDealItems', fromId, toId, itemTypeId, deal)
end

local function needsValueList(subTypeId)
  if subTypeId == nil then return false end
  for _, name in ipairs(AGREEMENT_VALUE_TYPES) do
    local id = dealAgreementTypeId(name)
    if id ~= nil and id == subTypeId then return true end
  end
  return false
end

--- The native "available" panel for one side, per item type, with the second-step value list for
--- the agreements that carry one. Truncation is reported, never silently applied.
local function dealCatalogue(fromId, toId, deal)
  local catalogue, truncated = {}, false
  for _, typeName in ipairs(ITEM_TYPE_ORDER) do
    local typeId = dealItemTypeId(typeName)
    if typeId ~= nil then
      local entries = possibleItems(fromId, toId, typeId, deal)
      if type(entries) == 'table' then
        local list, count = A.array(), 0
        for _, entry in ipairs(entries) do
          count = count + 1
          if #list < CATALOGUE_LIMIT then
            local record = availableEntry(entry)
            if typeName == 'AGREEMENTS' and needsValueList(number(entry.SubType)) then
              local values = possibleItems(fromId, toId, typeId, deal, number(entry.SubType))
              if type(values) == 'table' then
                local options = A.array()
                for _, value in ipairs(values) do
                  if #options < VALUE_LIMIT then options[#options+1] = availableEntry(value) end
                end
                record.values = options
                record.valueCount = #values
              end
            end
            list[#list+1] = record
          end
        end
        if count > #list then truncated = true end
        catalogue[typeName] = {items = list, total = count, itemTypeId = typeId}
      end
    end
  end
  return catalogue, truncated
end

--- The working-deal state of one pair. Reads only: GetWorkingDeal, HasPendingDeal,
--- AreWorkingDealsEqual and the item fields. `read` says which questions the engine answered.
local function dealState(ctx, other, withCatalogue)
  local state = {
    pending = A.null, equal = A.null, valid = A.null, unacceptable = A.null,
    mine = A.array(), theirs = A.array(), read = {}, note = A.null,
    itemCount = 0, incomingItemCount = 0, itemsComplete = true,
  }
  local pid = ctx.pid
  if DealManager == nil then
    A.unavailable('diplomacy', 'DealManager', 'Deal manager is unavailable in this context')
    state.read.manager = false
    state.note = 'DealManager is unavailable in this context; deal state is unknown.'
    return state
  end
  state.read.manager = true
  local pending = A.static('diplomacy', DealManager, 'HasPendingDeal', pid, other)
  state.pending = pending
  state.read.pending = type(pending) == 'boolean'
  local equal = A.static('diplomacy', DealManager, 'AreWorkingDealsEqual', pid, other)
  state.equal = equal
  state.read.equal = type(equal) == 'boolean'
  local deal, reason = workingDeal(pid, other, 'OUTGOING')
  if deal == nil then
    state.read.items = false
    state.note = reason
    return state
  end
  state.mine, state.itemsComplete = dealItems(deal)
  state.itemCount = #state.mine
  local valid = A.call('diplomacy', deal, 'IsValid')
  state.valid = valid
  state.read.valid = type(valid) == 'boolean'
  local unacceptable = A.call('diplomacy', deal, 'HasUnacceptableItems')
  state.unacceptable = unacceptable
  state.read.unacceptable = type(unacceptable) == 'boolean'
  local incoming = workingDeal(pid, other, 'INCOMING')
  if incoming ~= nil then
    local theirs, complete = dealItems(incoming)
    state.theirs = theirs
    state.incomingItemCount = #theirs
    state.incomingComplete = complete
  end
  if withCatalogue then
    local mine, mineTruncated = dealCatalogue(pid, other, deal)
    local theirs, theirsTruncated = dealCatalogue(other, pid, deal)
    state.available = {mine = mine, theirs = theirs, truncated = mineTruncated or theirsTruncated}
  end
  return state
end

-- ---------------------------------------------------------------------------
-- Sessions: identity, statement context and the derived option lists.
-- ---------------------------------------------------------------------------
local function sessionInfo(sessionId)
  local info = A.static('diplomacy', DiplomacyManager, 'GetSessionInfo', sessionId)
  if info == A.null then return nil end
  return info
end

--- The open session between the local player and one counterpart, or nil.
local function openSession(ctx, other)
  local session = A.static('diplomacy', DiplomacyManager, 'FindOpenSessionID', ctx.pid, other)
  if type(session) == 'number' then return session end
  return nil
end

--- The statement context of an observed session, plus the leader text the native screen shows.
local function sessionStatement(cached)
  if cached == nil then return nil end
  local context = statementContext(cached)
  if context == nil then return nil end
  local row = statementRow(context.statementType, context.subType, context.initiator, context.leaderKey, context.moodKey)
  local heardText, heardReason = statementText(cached, row)
  return {
    statementType = context.statementType, subType = context.subType, initiator = context.initiator,
    leaderKey = context.leaderKey, moodKey = context.moodKey,
    dealAction = A.enumName('DealProposalAction', DealProposalAction, cached.dealAction),
    respondingToDealAction = A.enumName('DealProposalAction', DealProposalAction, cached.respondingToDealAction),
    responseType = A.enumName('DiplomacyResponseTypes', DiplomacyResponseTypes, cached.responseType),
    heardText = heardText, heardReason = heardReason,
  }
end

--- The in-session options of an observed statement (the native conversation view).
local function conversationOptions(ctx, other, cached)
  if cached == nil then
    return nil, 'No statement has been observed on this session since the bridge attached'
  end
  local context = statementContext(cached)
  if context == nil then return nil, 'Statement type could not be decoded' end
  return statementOptions(ctx, context, other)
end

--- The GREETING selection rows the native overview is built from. The set does not depend on the
--- counterpart, only on the local leader, so it is read once per collector call. Memoized on a
--- fresh table at the start of every collection; nothing is cached across calls.
local openingCache
local function greetingRows(ctx)
  if openingCache then return openingCache end
  local leaderKey = leaderName(ctx.pid) or 'ANY'
  local row = statementRow('GREETING', 'NONE', 'HUMAN', leaderKey, 'ANY')
  if row == nil then
    openingCache = {error = 'No DiplomacyStatements GREETING row matched this ruleset'}
    return openingCache
  end
  local rows = selectionRows(row.Selections, leaderKey, 'ANY')
  if rows == nil then
    openingCache = {error = 'No DiplomacySelections row matched the GREETING statement in this ruleset'}
    return openingCache
  end
  openingCache = {rows = rows}
  return openingCache
end

--- The overview list: which statements this player may start a session with. Derived exactly as
--- AddStatmentOptions does - GREETING/NONE as the local player, ANY mood, Initiator HUMAN.
--- Legality is per pair, so withLegality=false (the collector) reports the ruleset's selection set
--- and leaves `available` unset, which means unknown, not legal; the submit path re-derives the
--- list with the engine's IsDiplomaticActionValid verdicts and refuses anything not available.
local function openingOptions(ctx, other, withLegality)
  local cache = greetingRows(ctx)
  if cache.error ~= nil then return nil, cache.error end
  local diplomacy
  if withLegality then
    diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
    if diplomacy == A.null then
      A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable for native selection legality')
      return nil, 'Diplomacy manager unavailable for native selection legality'
    end
  end
  local out = A.array()
  -- Keys this bridge already knows it cannot open are counted, not listed. They are ruleset rows
  -- with no RequestSession statement (or the view-only deal screens), so printing thirty of them
  -- once per counterpart was a fixed catalog dressed up as a situation.
  local unopenable = 0
  for _, selection in ipairs(cache.rows) do
    local choice = selection.Key
    if choice ~= 'CHOICE_EXIT' then
      local statement = OPENING_STATEMENTS[choice]
      if SCREEN_ONLY_KEYS[choice] or statement == nil then
        unopenable = unopenable + 1
      else
        local record = {
          choice = choice,
          label = A.plainText(A.loc(selection.Text)),
          statement = statement,
        }
        local tooltip = A.plainText(A.loc(selection.Tooltip))
        if tooltip ~= A.null then record.tooltip = tooltip end
        if WAR_CHOICES[choice] ~= nil then record.warType = WAR_CHOICES[choice] end
        if withLegality then
          local legal, reasons, checked = actionLegality(diplomacy, selection.DiplomaticActionType, other)
          if checked then record.available = legal end
          if reasons ~= nil then record.reasons = reasons end
        end
        out[#out+1] = record
      end
    end
  end
  return out, nil, unopenable
end

--- The generic responses an open session always understands, used only when no statement has been
--- observed yet so the ruleset option list cannot be derived.
local function genericOptions()
  local options = A.array()
  for _, choice in ipairs({'POSITIVE', 'NEGATIVE', 'RESPONSE_IGNORE'}) do
    options[#options+1] = {choice = choice, available = true, kindOfAnswer = 'response', label = choice, generic = true}
  end
  return options
end

-- ---------------------------------------------------------------------------
-- The collector: one record per open session, one per pair holding a deal without a session, and
-- one when a session is queued but not yet open.
-- ---------------------------------------------------------------------------
local function sessionRecord(ctx, sessionID, other)
  local cached = A.diplomacyStatements[sessionID]
  local statement = sessionStatement(cached)
  local dealKind = statement ~= nil and (statement.statementType == 'MAKE_DEAL' or statement.statementType == 'MAKE_DEMAND')
  local deal = dealState(ctx, other, dealKind == true)
  if dealKind ~= true and (deal.itemCount > 0 or deal.incomingItemCount > 0 or deal.pending == true) then
    -- A deal is in play even though the statement cache is cold; the catalogue is the expensive
    -- part of the record, so it is read only once a deal is known to exist.
    deal = dealState(ctx, other, true)
  end
  local options, note, extra = conversationOptions(ctx, other, cached)
  if options == nil then options = genericOptions() end
  local info = sessionInfo(sessionID)
  return {
    key = tostring(sessionID),
    kind = 'diplomacy', actionType = 'diplomacy', operation = 'response',
    operations = allOperations(),
    label = 'Diplomacy session with '..tostring(playerLabel(other)),
    mandatory = true,
    blocks = false,
    uiBlocking = true,
    sessionId = sessionID,
    otherPlayerId = other,
    initiatedBy = (info ~= nil and info.FromPlayer ~= nil) and info.FromPlayer or A.null,
    sessionOpen = A.static('diplomacy', DiplomacyManager, 'IsSessionIDOpen', sessionID),
    -- statementType/heardText stay explicit: null there means no statement has been observed for
    -- this session yet, which the model must not read as "the leader said nothing". The rest are
    -- properties OF an observed statement, so absent and null mean the same thing and the key goes.
    statementType = statement and statement.statementType or A.null,
    heardText = statement and statement.heardText or A.null,
    statementSubType = statement and statement.subType or nil,
    heardReason = statement and statement.heardReason or nil,
    dealAction = statement and statement.dealAction or nil,
    respondingToDealAction = statement and statement.respondingToDealAction or nil,
    -- No availableOpenings here. They are the same fixed catalog the `openings:<player>` record
    -- already carries, they cannot be used until this session closes, and repeating them per
    -- counterpart was the single largest line item in a decisions response.
    selectionSource = note == nil and 'native_diplomacy_tables' or 'generic_responses_only',
    selectionNote = note or nil,
    selectionHiddenCount = extra and extra.hidden or nil,
    deal = deal,
    options = options,
  }
end

--- A pair with a pending or drafted deal but no open session (a proposal awaiting the answer, or a
--- deal whose session was closed while the answer is outstanding).
local function dealRecord(ctx, other)
  local state = dealState(ctx, other, false)
  if state.read.manager ~= true then return nil end
  if state.pending ~= true and state.itemCount == 0 and state.incomingItemCount == 0 then return nil end
  return {
    key = 'deal:'..other,
    kind = 'diplomacy', actionType = 'diplomacy', operation = 'deal_propose',
    operations = dealOnlyOperations(),
    label = 'Diplomacy deal state with '..tostring(playerLabel(other)),
    mandatory = false,
    blocks = false,
    uiBlocking = state.pending == true,
    otherPlayerId = other,
    sessionId = A.null,
    sessionOpen = false,
    deal = state,
    options = A.array(),
    sessionNote = 'No session is open with this player.',
  }
end

--- A met and living player with neither a session nor a deal: the only thing to report is what a
--- session could be opened with. The GREETING set is ruleset data (one query per collection), and
--- per-pair legality is left to the engine at submission rather than guessed here.
local function openingsRecord(ctx, other)
  -- A list call gets the keys; asking about this one record (civ.decisions id=...) is what buys the
  -- per-pair legality query, which is a native call per opening per counterpart.
  local openings, _, unopenable = openingOptions(ctx, other, ctx.wanted ~= nil)
  if openings == nil then return nil end
  if #openings == 0 then return nil end
  return {
    key = 'openings:'..other,
    kind = 'diplomacy', actionType = 'diplomacy', operation = 'open',
    operations = A.array{'open'},
    label = 'Diplomatic openings with '..tostring(playerLabel(other)),
    mandatory = false,
    blocks = false,
    uiBlocking = false,
    otherPlayerId = other,
    sessionId = A.null,
    sessionOpen = false,
    options = openings,
    selectionSource = 'native_greeting_selections',
    -- An option with no `available` field was not checked against this pair, not ruled out.
    unopenableCount = unopenable > 0 and unopenable or A.null,
  }
end

local function diplomacyDecisions(ctx, out)
  if DiplomacyManager == nil then
    return A.unavailable('diplomacy', 'DiplomacyManager', 'Diplomacy namespace unavailable')
  end
  -- One GREETING read per collection, no matter how many counterparts are listed.
  openingCache = nil
  local queued = A.static('diplomacy', DiplomacyManager, 'HasQueuedSession', ctx.pid)
  -- A missing player manager cannot answer HasMet or native selection legality.
  local diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
  if diplomacy == A.null then
    return A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable')
  end
  local seen, found = {}, 0
  for other = 0, 63 do
    if other ~= ctx.pid and Players and Players[other] and A.call('diplomacy', diplomacy, 'HasMet', other) == true then
      local sessionID = openSession(ctx, other)
      if sessionID ~= nil then
        if not seen[sessionID] then
          seen[sessionID] = true
          found = found + 1
          out[#out+1] = sessionRecord(ctx, sessionID, other)
        end
      else
        local record = dealRecord(ctx, other)
        if record ~= nil then
          found = found + 1
          out[#out+1] = record
        elseif A.call('diplomacy', Players[other], 'IsAlive') == true then
          record = openingsRecord(ctx, other)
          if record ~= nil then found = found + 1; out[#out+1] = record end
        end
      end
    end
  end
  openingCache = nil
  if queued == true then
    -- HasQueuedSession is the native "a session is waiting" flag (DiplomacyActionView.lua:2464-2477
    -- uses it to know another session follows the current one), so it is reported whenever the
    -- engine says so instead of only when nothing else is listed.
    out[#out+1] = {
      key = 'queued',
      kind = 'diplomacy', actionType = 'diplomacy', operation = 'response',
      operations = A.array(SESSION_OPERATIONS),
      label = found == 0 and 'A diplomacy session is queued but not yet open'
        or 'A further diplomacy session is queued behind the open one(s)',
      mandatory = false, blocks = false, uiBlocking = true,
      options = A.array(),
      sessionNote = 'No open session id yet; observe again once the native window opens.',
    }
  end
end

-- ---------------------------------------------------------------------------
-- Published surface. decisions.lua resolves all three at call time, and the action-type table it
-- publishes at its own load time reads A.diplomacyActionSpec, so every one of them must exist here.
-- ---------------------------------------------------------------------------
A.diplomacyDecisions = diplomacyDecisions

-- ---------------------------------------------------------------------------
-- Submission plumbing. The decision helpers live in decisions.lua and own the
-- submitted/rejected/unknown truth; this module never re-implements it and never replays.
-- ---------------------------------------------------------------------------
local function helpers()
  assert(type(A.decisionRequest) == 'function' and type(A.decisionSubmit) == 'function'
    and type(A.decisionRefused) == 'function',
    'Diplomacy actions need the decision helpers (A.decisionRequest/Submit/Refused) from decisions.lua')
  return A.decisionRequest, A.decisionSubmit, A.decisionRefused
end

local function refused(status, reason, extra)
  local _, _, decline = helpers()
  return decline(status, reason, extra)
end

--- A native mutation must reach the engine without a wrapper that swallows errors: A.call/A.static
--- pcall internally and turn a throw into A.null, which a decided wrapper would then report as a
--- submitted request. Every mutation below checks the method exists first (a missing API is a named
--- unknown before anything is sent) and then calls the real function directly inside
--- A.decisionRequest, whose A.mutate wrapper owns the submitted/rejected/unknown truth.
local function missingMutation(owner, name, label)
  if owner == nil or owner == A.null then return label..' is unavailable in this context' end
  if type(owner[name]) ~= 'function' then return label..'.'..name..' is unavailable in this ruleset' end
  return nil
end

--- Availability first, then the real call, reported with the request truth.
local function mutate(owner, ownerLabel, name, fn)
  local missing = missingMutation(owner, name, ownerLabel)
  if missing ~= nil then return {status = 'unknown', error = missing} end
  return helpers()(fn)
end

--- One mutation step of a decision sequence.
local function mutation(label, owner, ownerLabel, name, fn)
  return {label = label, run = function() return mutate(owner, ownerLabel, name, fn) end}
end


--- Fresh state a caller can verify submission against. IsSessionIDOpen is the same query the
--- native screen validates its active session with (DiplomacyActionView.lua:297-306); it says
--- whether the session is still open now, not that a queued request was processed.
local function finish(ctx, result, session, other)
  result.observed = A.section('observed', function()
    if session ~= nil then
      return {
        sessionOpen = A.static('diplomacy', DiplomacyManager, 'IsSessionIDOpen', session),
        sessionId = session,
        otherPlayerId = other or A.null,
      }
    end
    local state = dealState(ctx, other, false)
    state.otherPlayerId = other
    return state
  end)
  return result
end

-- ---------------------------------------------------------------------------
-- Identity resolution. Every caller-supplied id is checked against live state: a player id must be
-- a real player, a session id must be open now and must connect exactly these two players, and a
-- deal item id must resolve inside the current working deal.
-- ---------------------------------------------------------------------------
--- The counterpart of an operation, in order: the caller's playerId, the re-collected record's
--- otherPlayerId, and - only when fromSession is true - the open session's own participants, which
--- are the engine's identity for that conversation (FindOpenSessionID / GetSessionInfo). A derived
--- counterpart is re-verified by liveSession before anything is sent, and an unresolvable one
--- refuses instead of guessing.
local function otherPlayer(ctx, args, record, fromSession)
  local other = number(args and args.playerId)
  if other == nil and record ~= nil then other = number(record.otherPlayerId) end
  if other == nil and fromSession == true then
    local session = number(args and args.sessionId)
    if session == nil and record ~= nil then session = number(record.sessionId) end
    if session ~= nil and A.static('diplomacy', DiplomacyManager, 'IsSessionIDOpen', session) == true then
      local info = sessionInfo(session)
      if info ~= nil then
        local from, to = number(info.FromPlayer), number(info.ToPlayer)
        if from == ctx.pid then other = to elseif to == ctx.pid then other = from end
      end
    end
    if other == nil then
      return nil, 'No playerId, and sessionId does not name an open session that connects you to another '
        ..'player; call civ.decisions again'
    end
  end
  assert(other ~= nil, 'diplomacy needs playerId=<other player id> from civ.decisions')
  assert(other ~= ctx.pid and other >= 0 and other < 64, 'playerId must be the other player\'s id, not the local player\'s')
  assert(Players and Players[other] ~= nil, 'Unknown player id; re-read civ.decisions')
  return other
end

local function requireMet(ctx, other)
  local diplomacy = A.call('diplomacy', ctx.player, 'GetDiplomacy')
  if diplomacy == A.null then
    A.unavailable('diplomacy', 'GetDiplomacy', 'Diplomacy manager unavailable')
    -- An unanswerable met state is unknown, never reported as a decided illegality.
    return false, 'Diplomacy manager unavailable; met state is unknown', 'unknown'
  end
  if A.call('diplomacy', diplomacy, 'HasMet', other) ~= true then
    return false, 'This player has not been met (Diplomacy.HasMet), so no native diplomatic action with them exists', 'illegal'
  end
  return true
end

--- The open session shared by ctx.pid and other, verified against the passed session id when one
--- was supplied. Returns session, reason.
local function liveSession(ctx, other, sessionId, record)
  local session = number(sessionId)
  if session == nil and record ~= nil then session = number(record.sessionId) end
  if session == nil then session = openSession(ctx, other) end
  if session == nil then
    return nil, 'No open diplomacy session with this player; call civ.decisions again'
  end
  if A.static('diplomacy', DiplomacyManager, 'IsSessionIDOpen', session) ~= true then
    return nil, 'Diplomacy session '..tostring(session)..' is no longer open; call civ.decisions again'
  end
  local info = sessionInfo(session)
  if info == nil then
    return nil, 'Diplomacy session '..tostring(session)..' has no session info; call civ.decisions again'
  end
  local from, to = number(info.FromPlayer), number(info.ToPlayer)
  local participants = {[ctx.pid] = true, [other] = true}
  if from == nil or to == nil or participants[from] ~= true or participants[to] ~= true or from == to then
    return nil, 'Diplomacy session '..tostring(session)..' does not connect player '..tostring(ctx.pid)
      ..' with player '..tostring(other)..'; re-read civ.decisions'
  end
  return session, nil
end

--- Is this (type, subtype, value type) something the engine currently offers to that player? The
--- match is the entry the native panel renders, including its ValidationResult.
local ITEM_MATCH = {
  GOLD = function(entry, args)
    if args.duration == nil then return true end
    local entryDuration = number(entry.Duration) or 0
    return (entryDuration == 0) == (number(args.duration) == 0)
  end,
  FAVOR = function() return true end,
  RESOURCES = function(entry, args) return number(entry.ForType) == number(args.valueType) end,
  AGREEMENTS = function(entry, args) return number(entry.SubType) == number(args.subType) end,
  CITIES = function(entry, args)
    return number(entry.ForType) == number(args.valueType) and number(entry.SubType) == number(args.subType)
  end,
  GREATWORK = function(entry, args)
    return number(entry.ForType) == number(args.valueType) and number(entry.SubType) == number(args.subType)
  end,
  CAPTIVE = function(entry, args) return number(entry.ForType) == number(args.valueType) end,
}
-- The fields each item type needs before it can be added (native click handlers read them from the
-- available entry, so an unspecified value would be a guess).
local ITEM_REQUIRED = {
  GOLD = {}, FAVOR = {},
  RESOURCES = {'valueType'}, AGREEMENTS = {'subType'},
  CITIES = {'subType', 'valueType'}, GREATWORK = {'subType', 'valueType'}, CAPTIVE = {'valueType'},
}

local function offeredEntry(ctx, other, deal, typeName, typeId, fromId, toId, args)
  for _, field in ipairs(ITEM_REQUIRED[typeName] or {}) do
    if number(args[field]) == nil then
      return nil, typeName..' needs '..field..'=<id from the deal.available catalogue entry for this item>'
    end
  end
  if typeName == 'AGREEMENTS' and needsValueList(number(args.subType)) and number(args.valueType) == nil then
    return nil, 'This agreement carries a value (tech, alliance type or war target); pass valueType from the entry\'s values list'
  end
  local entries = possibleItems(fromId, toId, typeId, deal)
  if type(entries) ~= 'table' then
    return nil, 'The engine did not return an available-item list for this item type'
  end
  local match
  for _, entry in ipairs(entries) do
    if ITEM_MATCH[typeName](entry, args) then match = entry; break end
  end
  if match == nil then
    return nil, 'The engine does not offer that item to this player right now (see the record\'s deal.available catalogue)'
  end
  if match.IsValid ~= true then
    local validation = A.enumName('DealValidationResult', DealValidationResult, match.ValidationResult)
    local dependency = DealValidationResult ~= nil and DealValidationResult.MISSING_DEPENDENCY ~= nil
      and number(match.ValidationResult) == number(DealValidationResult.MISSING_DEPENDENCY)
    if not dependency then
      return nil, 'The engine refuses that item now ('..tostring(validation)..'); see deal.available.'
        ..typeName..' for the entries it does offer'
    end
  end
  return match, nil
end

-- ---------------------------------------------------------------------------
-- Session operations.
-- ---------------------------------------------------------------------------
local function openingKey(ctx, other, key)
  local options, note = openingOptions(ctx, other, true)
  if options == nil then return nil, note end
  for _, option in ipairs(options) do
    if option.choice == key then
      if option.available ~= true then
        local detail = option.reasons ~= nil and option.reasons ~= A.null and tostring(option.reasons[1])
          or 'the engine does not report this opening as legal'
        return nil, 'This opening is not available right now: '..detail
      end
      return option, nil
    end
  end
  return nil, 'key must be an opening listed by the civ.decisions openings record for this player'
end

--- open: the native overview path. CHOICE_MAKE_DEAL / CHOICE_MAKE_DEMAND clear the working deal
--- first; CHOICE_MAKE_PEACE stages the same locked MAKE_PEACE agreement on both sides and then
--- opens MAKE_DEAL, exactly as DiplomacyActionView.lua:407-492 does.
local function submitOpen(ctx, args, record)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason) end
  if A.static('diplomacy', DiplomacyManager, 'HasQueuedSession', ctx.pid) == true then
    return refused('illegal', 'A diplomacy session is already queued; answer or close it before opening another')
  end
  local existing = openSession(ctx, other)
  if existing ~= nil then
    return refused('illegal', 'A session with this player is already open; use response/statement/close or the deal operations',
      {sessionId = existing, otherPlayerId = other})
  end
  if A.call('diplomacy', GameConfiguration, 'IsPaused') == true then
    return refused('illegal', 'The game is paused; the native overview refuses to start a session while paused')
  end
  -- DiplomacyRibbon.lua:60-67 opens a leader only when the local player is alive and has met them.
  local localConfig = PlayerConfigurations and PlayerConfigurations[ctx.pid]
  if localConfig ~= nil and A.call('diplomacy', localConfig, 'IsAlive') == false then
    return refused('illegal', 'The local player is not alive; the native ribbon refuses to open diplomacy')
  end
  local key = text(args.key) or text(args.choice)
  assert(key ~= nil, 'diplomacy open needs key=<opening key from the civ.decisions openings record>')
  if SCREEN_ONLY_KEYS[key] then
    return refused('illegal', 'key '..key..' only raises the pending-deal screen (DealManager.ViewPendingDeal). '
      ..'The deal it shows is already reported in the decision record\'s deal state.')
  end
  local option, reason = openingKey(ctx, other, key)
  if option == nil then return refused('illegal', reason, {otherPlayerId = other}) end
  local statement = OPENING_STATEMENTS[key]
  assert(statement ~= nil, 'This opening has no native RequestSession statement; re-read civ.decisions')
  local items = A.array()
  local skippedClear
  local clearFirst = (key == 'CHOICE_MAKE_DEAL' or key == 'CHOICE_MAKE_PEACE' or key == 'CHOICE_MAKE_DEMAND')
  if clearFirst then
    if DealManager == nil then
      return refused('unknown', 'DealManager is unavailable in this context, so the working deal cannot be prepared for '
        ..key..'; the native overview clears it first (DiplomacyActionView.lua:435-489)')
    end
    local pending = A.static('diplomacy', DealManager, 'HasPendingDeal', ctx.pid, other)
    if pending == false then
      items[#items+1] = mutation('ClearWorkingDeal OUTGOING', DealManager, 'DealManager', 'ClearWorkingDeal',
        function() return DealManager.ClearWorkingDeal(dealDirectionId('OUTGOING'), ctx.pid, other) end)
    else
      -- The native path clears only when nothing is pending (DiplomacyActionView.lua:435-489);
      -- anything else keeps the existing draft.
      skippedClear = pending == true and 'a proposal is already pending, so the native path keeps the working deal'
        or 'HasPendingDeal did not answer, so the working deal was left untouched'
    end
  end
  if key == 'CHOICE_MAKE_PEACE' then
    items[#items+1] = {label = 'stage locked MAKE_PEACE agreement', run = function()
      local dealMissing = missingMutation(DealManager, 'GetWorkingDeal', 'DealManager')
      if dealMissing ~= nil then return {status = 'unknown', error = dealMissing} end
      local deal = DealManager.GetWorkingDeal(dealDirectionId('OUTGOING'), ctx.pid, other)
      if deal == nil then
        return {status = 'unknown', error = 'the engine returned no working deal, so peace could not be staged'}
      end
      local addMissing = missingMutation(deal, 'AddItemOfType', 'DiplomacyDeal')
      if addMissing ~= nil then return {status = 'unknown', error = addMissing} end
      local captured
      local add = decisionRequest(function()
        captured = deal:AddItemOfType(dealItemTypeId('AGREEMENTS'), ctx.pid)
        return true
      end)
      if add.status ~= 'submitted' then return add end
      if captured == nil then
        return {status = 'unknown', error = 'AddItemOfType returned no item, so the peace agreement could not be configured'}
      end
      local itemMissing = missingMutation(captured, 'SetSubType', 'DiplomacyDealItem')
      if itemMissing ~= nil then return {status = 'unknown', error = itemMissing} end
      local set = decisionRequest(function() return captured:SetSubType(dealAgreementTypeId('MAKE_PEACE')) end)
      if set.status ~= 'submitted' then return set end
      local lockMissing = missingMutation(captured, 'SetLocked', 'DiplomacyDealItem')
      if lockMissing ~= nil then return {status = 'unknown', error = lockMissing} end
      local locked = decisionRequest(function() return captured:SetLocked(true) end)
      if locked.status ~= 'submitted' then return locked end
      -- Native validates the draft here so peace is staged on both sides; the result is reported and
      -- a throw stops the sequence before the session is opened on a half-staged peace draft.
      local validateMissing = missingMutation(deal, 'Validate', 'DiplomacyDeal')
      if validateMissing ~= nil then return {status = 'unknown', error = validateMissing} end
      local validated
      local check = decisionRequest(function() validated = deal:Validate(); return true end)
      if check.status ~= 'submitted' then return check end
      return {status = 'submitted', acknowledgement = 'accepted',
        validation = A.enumName('DealValidationResult', DealValidationResult, validated)}
    end}
  end
  items[#items+1] = mutation('RequestSession '..statement, DiplomacyManager, 'DiplomacyManager', 'RequestSession',
    function() return DiplomacyManager.RequestSession(ctx.pid, other, statement) end)
  local result = submit(items, 'The native session request is queued: the engine answers with a statement on the '
    ..'Events.DiplomacyStatement stream, so re-observe before assuming an outcome. Proposing terms is a separate step.')
  result.otherPlayerId = other
  result.statement = statement
  result.opening = {choice = option.choice, label = option.label, warType = option.warType}
  result.skippedClear = skippedClear or A.null
  return finish(ctx, result, nil, other)
end

--- response / statement / close against one open session.
local function submitSession(ctx, args, record, operation)
  local decisionRequest, submit = helpers()
  local other, otherReason = otherPlayer(ctx, args, record, true)
  if other == nil then return refused('stale', otherReason) end
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local session, reason = liveSession(ctx, other, args.sessionId, record)
  if session == nil then return refused('stale', reason, {otherPlayerId = other}) end
  local key = text(args.key) or text(args.choice)
  if operation == 'close' or key == 'CHOICE_EXIT' then
    local closeItem = mutation('CloseSession '..session, DiplomacyManager, 'DiplomacyManager', 'CloseSession',
      function() return DiplomacyManager.CloseSession(session) end)
    local result = submit({closeItem}, 'The session was closed through the native Goodbye path (CloseSession). Submission is not completion: '
      ..'observed.sessionOpen is a fresh read, not an outcome claim.')
    result.otherPlayerId = other
    return finish(ctx, result, session, other)
  end
  assert(key ~= nil, 'diplomacy '..operation..' needs key=<selection or statement key from civ.decisions>')
  local cached = A.diplomacyStatements[session]
  local options = conversationOptions(ctx, other, cached)
  local validated = false
  if options ~= nil then
    local found
    for _, option in ipairs(options) do
      if option.choice == key or (operation == 'statement' and option.choice == 'CHOICE_'..key) then found = option; break end
    end
    if found == nil then
      return refused('illegal', 'key is not among the selections this session currently offers; call civ.decisions(id=...) '
        ..'and use one of its options', {sessionId = session, otherPlayerId = other})
    end
    if found.available ~= true then
      local detail = found.reasons ~= A.null and tostring(found.reasons[1]) or 'the engine reports it as unavailable'
      return refused('illegal', 'That selection is not available right now: '..detail,
        {sessionId = session, otherPlayerId = other})
    end
    validated = true
  elseif operation == 'statement' then
    -- A statement is a strong engine action and there is no generic fallback set for it, so an
    -- unobservable option list refuses instead of forwarding an unchecked name.
    return refused('unknown', 'No statement has been observed on this session since the bridge attached, so its '
      ..'selection list cannot be derived. Re-observe after the engine sends the next statement, or answer with '
      ..'operation="response" using a generic response name.', {sessionId = session, otherPlayerId = other})
  elseif RESPONSE_KEYS[key] == nil or not GENERIC_RESPONSE_KEYS[RESPONSE_KEYS[key]] then
    return refused('unknown', 'No statement has been observed on this session, so '..key..' cannot be validated against '
      ..'the ruleset selection list. Generic engine responses (POSITIVE, NEGATIVE, RESPONSE_IGNORE) remain valid.',
      {sessionId = session, otherPlayerId = other})
  end
  local result
  if operation == 'response' then
    local response = RESPONSE_KEYS[key] or key
    result = submit({mutation('AddResponse '..response, DiplomacyManager, 'DiplomacyManager', 'AddResponse',
      function() return DiplomacyManager.AddResponse(session, ctx.pid, response) end)})
  else
    -- Statement names are the engine's (MAKE_PEACE, DECLARE_FORMAL_WAR, ...); the UI key carries the
    -- same name with the CHOICE_ prefix (DiplomacyActionView.lua:499-529), so both spellings work.
    local statement = key:match('^CHOICE_(.+)$') or key
    result = submit({mutation('AddStatement '..statement, DiplomacyManager, 'DiplomacyManager', 'AddStatement',
      function() return DiplomacyManager.AddStatement(session, ctx.pid, statement) end)})
  end
  result.otherPlayerId = other
  result.sessionId = session
  result.selectionValidated = validated
  if not validated then
    result.note = 'The selection list could not be derived from the ruleset, so this key was not checked against it. '
      ..'The engine accepts or ignores the response; re-observe to see the current statement.'
  end
  return finish(ctx, result, session, other)
end

-- ---------------------------------------------------------------------------
-- Deal operations. The working deal is a draft: editing it spends nothing and accepts nothing.
-- ---------------------------------------------------------------------------
local function sideOf(ctx, other, args)
  local from = args.from
  if from == nil or from == 'me' then return ctx.pid end
  if from == 'them' then return other end
  local id = number(from)
  assert(id ~= nil and (id == ctx.pid or id == other),
    'from must be "me", "them", or one of the two player ids of this pair')
  return id
end

local function dealAndItem(ctx, other, itemIdValue)
  local deal, reason = workingDeal(ctx.pid, other, 'OUTGOING')
  if deal == nil then
    return nil, nil, 'No outgoing working deal exists for this pair; open a MAKE_DEAL session first ('..tostring(reason)..')'
  end
  local itemId = number(itemIdValue)
  assert(itemId ~= nil, 'deal item operations need itemId=<item id from the civ.decisions deal items>')
  local item = A.call('diplomacy', deal, 'FindItemByID', itemId)
  if item == nil or item == A.null then
    return nil, nil, 'Deal item '..tostring(itemId)..' is not in the current working deal; re-read civ.decisions '
      ..'(item ids are re-created whenever the item is re-added)'
  end
  return deal, item, nil
end

--- A pending proposal makes the native deal screen read-only for a human counterpart
--- (DiplomacyDealView.lua:1131-1150: the panels are only viewable, the action buttons are hidden).
local function humanPendingBlock(ctx, other, action)
  local pending = A.static('diplomacy', DealManager, 'HasPendingDeal', ctx.pid, other)
  if pending == true and isHuman(other) == true then
    return refused('illegal', 'A proposal to this human player is pending and the native deal screen is read-only until '
      ..'they answer (DiplomacyDealView.lua:1131-1150); use '..action)
  end
  return nil
end

--- deal_item_add: one native AddItemOfType followed by the setters the native click handlers use.
local function submitItemAdd(ctx, args, record)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local blocked = humanPendingBlock(ctx, other, 'deal_adjust or deal_close')
  if blocked ~= nil then blocked.otherPlayerId = other; return blocked end
  local deal, reason = workingDeal(ctx.pid, other, 'OUTGOING')
  if deal == nil then
    return refused('illegal', 'No outgoing working deal exists for this pair. Open a MAKE_DEAL session first ('
      ..tostring(reason)..')', {otherPlayerId = other})
  end
  local typeName = text(args.itemType)
  assert(typeName ~= nil, 'deal_item_add needs itemType, one of '..table.concat(ITEM_TYPE_ORDER, ', '))
  local typeId = dealItemTypeId(typeName)
  if typeId == nil then
    return refused('illegal', 'itemType '..typeName..' does not exist in this ruleset\'s DealItemTypes', {otherPlayerId = other})
  end
  local subType = number(args.subType)
  if subType == nil and text(args.subTypeName) ~= nil then
    subType = dealAgreementTypeId(args.subTypeName)
    if subType == nil then
      return refused('illegal', 'Unknown agreement type name: '..tostring(args.subTypeName), {otherPlayerId = other})
    end
  end
  local valueType = number(args.valueType)
  local amount = number(args.amount)
  local duration = number(args.duration)
  if duration == nil and typeName == 'RESOURCES' then duration = 30 end
  if duration == nil and typeName == 'FAVOR' then duration = 0 end
  local matchArgs = {valueType = valueType, subType = subType, duration = duration}
  local fromId = sideOf(ctx, other, args)
  local toId = fromId == ctx.pid and other or ctx.pid
  local entry, entryReason = offeredEntry(ctx, other, deal, typeName, typeId, fromId, toId, matchArgs)
  if entry == nil then return refused('illegal', entryReason, {otherPlayerId = other}) end
  if amount == nil and typeName == 'GOLD' then
    -- The native panel offers 100 gold or 10 gold for 30 turns as UI defaults; choosing how much
    -- wealth to offer is the caller's decision, so no amount is invented here.
    return refused('illegal', 'GOLD needs an explicit amount (the native panel\'s default is a UI convenience, not '
      ..'a rule)', {otherPlayerId = other, maxAmount = availableEntry(entry).maxAmount})
  end
  if amount == nil and (typeName == 'RESOURCES' or typeName == 'FAVOR') then amount = 1 end
  local captured
  local items = A.array()
  items[#items+1] = {label = 'AddItemOfType '..typeName, run = function()
    local missing = missingMutation(deal, 'AddItemOfType', 'DiplomacyDeal')
    if missing ~= nil then return {status = 'unknown', error = missing} end
    local result = decisionRequest(function()
      if typeName == 'CITIES' then
        -- DiplomacyDealView.lua:1593: AddItemOfType(CITIES, from, other, subType, valueType).
        captured = deal:AddItemOfType(typeId, fromId, toId, subType or 0, valueType or 0)
      else
        captured = deal:AddItemOfType(typeId, fromId)
      end
      return true
    end)
    if result.status ~= 'submitted' then return result end
    if captured == nil then
      return {status = 'unknown', error = 'AddItemOfType returned no item; re-read the draft before continuing'}
    end
    return result
  end}
  -- The item object AddItemOfType returns is the only trustworthy identity here: the native click
  -- handlers configure that same object, never a re-lookup.
  items[#items+1] = {label = 'configure item', run = function()
    local item = captured
    if item == nil then
      return {status = 'unknown', error = 'the added item is no longer known; re-read the draft'}
    end
    if subType ~= nil then
      local set = mutate(item, 'DiplomacyDealItem', 'SetSubType', function() return item:SetSubType(subType) end)
      if set.status ~= 'submitted' then return set end
    end
    if valueType ~= nil then
      local set = mutate(item, 'DiplomacyDealItem', 'SetValueType', function() return item:SetValueType(valueType) end)
      if set.status ~= 'submitted' then return set end
    end
    local warType = text(args.warType)
    if warType ~= nil then
      local set = mutate(item, 'DiplomacyDealItem', 'SetParameterValue',
        function() return item:SetParameterValue('WarType', warType) end)
      if set.status ~= 'submitted' then return set end
    end
    if duration ~= nil then
      local set = mutate(item, 'DiplomacyDealItem', 'SetDuration', function() return item:SetDuration(duration) end)
      if set.status ~= 'submitted' then return set end
    end
    if amount ~= nil then
      local max = number(A.call('diplomacy', item, 'GetMaxAmount'))
      if max ~= nil and (amount < 1 or amount > max) then
        return {status = 'rejected', error = 'amount must be between 1 and '..tostring(max)..' for this item '
          ..'(the native editor clips to GetMaxAmount; this bridge will not change the number you asked for)'}
      end
      local set = mutate(item, 'DiplomacyDealItem', 'SetAmount', function() return item:SetAmount(amount) end)
      if set.status ~= 'submitted' then return set end
    end
    return {status = 'submitted', acknowledgement = 'not_observable'}
  end}
  -- The native handlers re-check IsValid after configuring an item and undo the add when the engine
  -- refuses it (DiplomacyDealView.lua:1339-1345, :1594-1600 passes the deal for a ceded city).
  items[#items+1] = {label = 'IsValid', run = function()
    local item = captured
    if item == nil then
      return {status = 'unknown', error = 'the added item is no longer known, so its validity is unknown'}
    end
    local valid = typeName == 'CITIES' and A.call('diplomacy', item, 'IsValid', deal) or A.call('diplomacy', item, 'IsValid')
    if valid == false then
      local removed = mutate(deal, 'DiplomacyDeal', 'RemoveItemByID', function() return deal:RemoveItemByID(item:GetID()) end)
      return {status = 'rejected', error = 'the engine marked the added item invalid; removal was '
        ..(removed.status == 'submitted' and 'submitted' or 'not confirmed ('..tostring(removed.status)..')')}
    end
    return {status = 'submitted', acknowledgement = valid == true and 'accepted' or 'not_observable'}
  end}
  local result = submit(items, 'The item was added to the outgoing working draft only. Nothing is proposed, accepted '
    ..'or spent: send deal_propose, deal_balance or deal_adjust when the draft is what you want.')
  result.otherPlayerId = other
  result.item = A.section('item', function()
    local item = captured
    if item == nil or item == A.null then return A.null end
    return itemRecord(item)
  end)
  return finish(ctx, result, nil, other)
end

local function submitItemSet(ctx, args, record)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local blocked = humanPendingBlock(ctx, other, 'deal_adjust or deal_close')
  if blocked ~= nil then blocked.otherPlayerId = other; return blocked end
  local deal, item, reason = dealAndItem(ctx, other, args.itemId)
  if deal == nil then return refused('illegal', reason, {otherPlayerId = other}) end
  if A.call('diplomacy', item, 'IsLocked') == true then
    return refused('illegal', 'This deal item is locked and the native screen does not edit it '
      ..'(DiplomacyDealView.lua:1611-1650)', {otherPlayerId = other})
  end
  local amount = number(args.amount)
  local duration = number(args.duration)
  local valueType = number(args.valueType)
  assert(amount ~= nil or duration ~= nil or valueType ~= nil,
    'deal_item_set needs at least one of amount, duration or valueType')
  local typeId = A.call('diplomacy', item, 'GetType')
  local subType = number(A.call('diplomacy', item, 'GetSubType'))
  local fromId = number(A.call('diplomacy', item, 'GetFromPlayerID'))
  if fromId == nil then
    return refused('unknown', 'The engine did not report which player is offering this item, so the edit cannot be '
      ..'replayed safely (the native editor re-adds the item with its original side)', {otherPlayerId = other})
  end
  local typeName = A.enumName('DealItemTypes', DealItemTypes, typeId)
  -- Every readable field is preserved across the re-add exactly as the native editor does; a field
  -- the engine did not answer stays unknown and is left alone rather than replaced by a guess.
  local beforeDuration = number(A.call('diplomacy', item, 'GetDuration'))
  local beforeValueType = number(A.call('diplomacy', item, 'GetValueType'))
  if amount ~= nil then
    local max = number(A.call('diplomacy', item, 'GetMaxAmount'))
    if max == nil then
      return refused('unknown', 'The engine did not report GetMaxAmount for this item, so the amount cannot be checked',
        {otherPlayerId = other})
    end
    if amount < 1 or amount > max then
      return refused('illegal', 'amount must be between 1 and '..tostring(max)..' for this item (the native editor clips '
        ..'to GetMaxAmount; this bridge will not silently change the number you asked for)',
        {otherPlayerId = other, maxAmount = max})
    end
  end
  local captured, reAdded = nil, false
  local items = A.array()
  local function current()
    if reAdded then return captured end
    return item
  end
  if amount ~= nil or duration ~= nil then
    reAdded = true
    -- The deal manager does not update an item in place (DiplomacyDealView.lua:1398-1404): the native
    -- editor removes the item and re-adds it with its type/subtype/duration/value type preserved.
    items[#items+1] = mutation('RemoveItemByID (re-add)', deal, 'DiplomacyDeal', 'RemoveItemByID',
      function() return deal:RemoveItemByID(number(args.itemId)) end)
    items[#items+1] = {label = 'AddItemOfType', run = function()
      local missing = missingMutation(deal, 'AddItemOfType', 'DiplomacyDeal')
      if missing ~= nil then return {status = 'unknown', error = missing} end
      local result = decisionRequest(function()
        if number(typeId) == dealItemTypeId('CITIES') then
          local toId = fromId == ctx.pid and other or ctx.pid
          captured = deal:AddItemOfType(typeId, fromId, toId, subType or 0, beforeValueType or 0)
        else
          captured = deal:AddItemOfType(typeId, fromId)
        end
        return true
      end)
      if result.status ~= 'submitted' then return result end
      if captured == nil then
        return {status = 'unknown', error = 'the re-added item could not be read back; the draft changed without confirmation'}
      end
      return result
    end}
    items[#items+1] = {label = 'preserve subtype/value/duration', run = function()
      local found = current()
      if found == nil then
        return {status = 'unknown', error = 'the re-added item could not be read back'}
      end
      if subType ~= nil then
        local set = mutate(found, 'DiplomacyDealItem', 'SetSubType', function() return found:SetSubType(subType) end)
        if set.status ~= 'submitted' then return set end
      end
      if beforeValueType ~= nil then
        local set = mutate(found, 'DiplomacyDealItem', 'SetValueType', function() return found:SetValueType(beforeValueType) end)
        if set.status ~= 'submitted' then return set end
      end
      if beforeDuration ~= nil then
        return mutate(found, 'DiplomacyDealItem', 'SetDuration', function() return found:SetDuration(beforeDuration) end)
      end
      return {status = 'submitted', acknowledgement = 'not_observable'}
    end}
  end
  items[#items+1] = {label = 'apply edit', run = function()
    local found = current()
    if found == nil then
      return {status = 'unknown', error = 'the item is no longer known; re-read the draft'}
    end
    if duration ~= nil then
      local set = mutate(found, 'DiplomacyDealItem', 'SetDuration', function() return found:SetDuration(duration) end)
      if set.status ~= 'submitted' then return set end
    end
    if valueType ~= nil then
      local set = mutate(found, 'DiplomacyDealItem', 'SetValueType', function() return found:SetValueType(valueType) end)
      if set.status ~= 'submitted' then return set end
    end
    if amount ~= nil then
      local set = mutate(found, 'DiplomacyDealItem', 'SetAmount', function() return found:SetAmount(amount) end)
      if set.status ~= 'submitted' then return set end
    end
    local valid = typeName == 'CITIES' and A.call('diplomacy', found, 'IsValid', deal)
      or A.call('diplomacy', found, 'IsValid')
    if valid == false then
      return {status = 'rejected', error = 'the engine marks the edited item invalid; the draft now holds that item'}
    end
    return {status = 'submitted', acknowledgement = valid == true and 'accepted' or 'not_observable'}
  end}
  local result = submit(items, 'The draft was edited in place (the native editor removes and re-adds the item). '
    ..'Nothing is proposed, accepted or spent.')
  result.otherPlayerId = other
  result.item = A.section('item', function()
    local found = current()
    if found == nil or found == A.null then return A.null end
    return itemRecord(found)
  end)
  return finish(ctx, result, nil, other)
end

local function submitItemRemove(ctx, args, record)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local blocked = humanPendingBlock(ctx, other, 'deal_adjust or deal_close')
  if blocked ~= nil then blocked.otherPlayerId = other; return blocked end
  local deal, item, reason = dealAndItem(ctx, other, args.itemId)
  if deal == nil then return refused('illegal', reason, {otherPlayerId = other}) end
  if A.call('diplomacy', item, 'IsLocked') == true then
    return refused('illegal', 'This deal item is locked (a peace agreement) and cannot be removed; the native screen '
      ..'hides its remove button (DiplomacyDealView.lua:1611-1635)', {otherPlayerId = other})
  end
  local result = submit({mutation('RemoveItemByID', deal, 'DiplomacyDeal', 'RemoveItemByID',
    function() return deal:RemoveItemByID(number(args.itemId)) end)},
    'The item was removed from the outgoing working draft only.')
  result.otherPlayerId = other
  return finish(ctx, result, nil, other)
end

local function submitItemUnacceptable(ctx, args, record)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local deal, item, reason = dealAndItem(ctx, other, args.itemId)
  if deal == nil then return refused('illegal', reason, {otherPlayerId = other}) end
  if number(A.call('diplomacy', item, 'GetFromPlayerID')) ~= ctx.pid then
    return refused('illegal', 'Only an item the local player is offering can be marked unacceptable '
      ..'(DiplomacyDealView.lua:1611-1655)', {otherPlayerId = other})
  end
  assert(DealProposalAction ~= nil and DealProposalAction.INSPECT ~= nil,
    'DealProposalAction.INSPECT is unavailable in this context')
  local result = submit({
    mutation('SetUnacceptableItemByID', deal, 'DiplomacyDeal', 'SetUnacceptableItemByID',
      function() return deal:SetUnacceptableItemByID(number(args.itemId)) end),
    -- Native follows Stop Asking with an INSPECT send so the AI re-evaluates the offer.
    mutation('SendWorkingDeal INSPECT', DealManager, 'DealManager', 'SendWorkingDeal',
      function() return DealManager.SendWorkingDeal(DealProposalAction.INSPECT, ctx.pid, other) end),
  }, 'The item is marked unacceptable to the local player and the native INSPECT request was sent. '
    ..'Re-observe: the engine answers asynchronously.')
  result.otherPlayerId = other
  return finish(ctx, result, nil, other)
end

--- deal_clear / deal_copy_incoming: draft-only state changes.
local function submitDraft(ctx, args, record, operation)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  local blocked = humanPendingBlock(ctx, other, operation == 'deal_clear' and 'deal_close' or 'deal_adjust or deal_close')
  if blocked ~= nil then blocked.otherPlayerId = other; return blocked end
  local deal, reason = workingDeal(ctx.pid, other, 'OUTGOING')
  if deal == nil then return refused('illegal', reason, {otherPlayerId = other}) end
  local items, note = A.array(), nil
  if operation == 'deal_clear' then
    items[#items+1] = mutation('ClearWorkingDeal OUTGOING', DealManager, 'DealManager', 'ClearWorkingDeal',
      function() return DealManager.ClearWorkingDeal(dealDirectionId('OUTGOING'), ctx.pid, other) end)
    note = 'The outgoing draft was cleared. Nothing was proposed, accepted or spent.'
  else
    items[#items+1] = mutation('CopyIncomingToOutgoingWorkingDeal', DealManager, 'DealManager', 'CopyIncomingToOutgoingWorkingDeal',
      function() return DealManager.CopyIncomingToOutgoingWorkingDeal(ctx.pid, other) end)
    note = 'The counterpart\'s current offer was copied into the outgoing draft so it can be reviewed and edited '
      ..'(the same copy the native deal screen makes on every incoming update). Nothing was accepted or spent.'
  end
  local result = submit(items, note)
  result.otherPlayerId = other
  return finish(ctx, result, nil, other)
end

--- The draft must be valid before the native action buttons appear
--- (DiplomacyDealView.lua:440-478: bDealValid = item count > 0 and Validate() == VALID).
local function draftGate(deal, requireValid)
  if deal == nil then return false, 'The outgoing working deal is missing; re-observe with civ.decisions' end
  local count = number(A.call('diplomacy', deal, 'GetItemCount'))
  if count == nil or count == 0 then
    return false, 'The outgoing deal is empty; add the terms you want first (deal_item_add) or copy the counterpart\'s '
      ..'offer (deal_copy_incoming)'
  end
  if requireValid then
    local validation = A.call('diplomacy', deal, 'Validate')
    local validId = namespaceId(DealValidationResult, 'VALID')
    if number(validation) == nil or validId == nil then
      return false, 'The engine did not report the deal validation result, so the native send path cannot be confirmed'
    end
    if number(validation) ~= validId then
      return false, 'The engine validates this draft as '
        ..tostring(A.enumName('DealValidationResult', DealValidationResult, validation))
        ..'; the native send buttons are only available for a valid deal. Re-read civ.decisions for the draft items.'
    end
  end
  return true, nil
end

--- A deal request: SendWorkingDeal with the native action, behind the native gates.
local function submitDealRequest(ctx, args, record, operation)
  local decisionRequest, submit = helpers()
  local other = otherPlayer(ctx, args, record)
  local met, metReason, metStatus = requireMet(ctx, other)
  if not met then return refused(metStatus or 'illegal', metReason, {otherPlayerId = other}) end
  if DealProposalAction == nil then
    return refused('unknown', 'DealProposalAction is unavailable in this context, so no deal request can be formed')
  end
  local actionName = ({
    deal_balance = 'EQUALIZE', deal_propose = 'PROPOSED', deal_adjust = 'ADJUSTED', deal_demand = 'DEMANDED',
    deal_accept = 'ACCEPTED', deal_reject = 'REJECTED', deal_reject_permanent = 'REJECTED_PERMANENT',
    deal_close = 'CLOSED',
  })[operation]
  assert(actionName ~= nil, 'Unsupported deal request: '..tostring(operation))
  local action = proposalActionId(actionName)
  if action == nil then
    return refused('unknown', 'DealProposalAction.'..actionName..' is unavailable in this ruleset')
  end
  local deal, dealReason = workingDeal(ctx.pid, other, 'OUTGOING')
  local pending = A.static('diplomacy', DealManager, 'HasPendingDeal', ctx.pid, other)
  local equal = A.static('diplomacy', DealManager, 'AreWorkingDealsEqual', ctx.pid, other)
  local session = openSession(ctx, other)
  -- Gates copied from the native deal view, one per action.
  if (operation == 'deal_propose' or operation == 'deal_balance' or operation == 'deal_demand'
      or operation == 'deal_adjust') and pending == true then
    return refused('illegal', 'A proposal to this player is already pending; the native path does nothing until it is '
      ..'answered (DiplomacyDealView.lua:144-167)', {otherPlayerId = other})
  end
  if operation ~= 'deal_close' then
    local ok, why = draftGate(deal, operation ~= 'deal_reject' and operation ~= 'deal_reject_permanent')
    if not ok then return refused('illegal', why, {otherPlayerId = other, dealReason = dealReason or A.null}) end
  end
  if operation == 'deal_accept' then
    if pending == true then
      return refused('illegal', 'Your own proposal is pending; the native Accept button is hidden while it is '
        ..'(DiplomacyDealView.lua:436-460)', {otherPlayerId = other})
    end
    if equal ~= true then
      return refused('illegal', 'The two working deals are not equal (DealManager.AreWorkingDealsEqual is '
        ..tostring(equal)..'), so the native screen proposes or adjusts instead of accepting '
        ..'(DiplomacyDealView.lua:526-604). Copy the current offer with deal_copy_incoming and review it first.',
        {otherPlayerId = other})
    end
  end
  if operation == 'deal_adjust' and equal == true then
    return refused('illegal', 'The two working deals are already equal, so there is nothing to counter-propose; '
      ..'deal_propose or deal_accept are the native paths', {otherPlayerId = other})
  end
  if operation == 'deal_close' and pending ~= true then
    return refused('illegal', 'No proposal of yours is pending with this player, so there is nothing to cancel; the '
      ..'native path only sends CLOSED for a pending deal (DiplomacyDealView.lua:644-655)', {otherPlayerId = other})
  end
  if operation == 'deal_reject_permanent' then
    -- DiplomacyDealView.lua:631-640: only an unacceptable item the local player offered leads here.
    local found = false
    if deal ~= nil then
      local ok = pcall(function()
        for item in deal:Items() do
          if A.call('diplomacy', item, 'IsUnacceptable') == true
            and number(A.call('diplomacy', item, 'GetFromPlayerID')) == ctx.pid then
            found = true
          end
        end
      end)
      if not ok then found = false end
    end
    if not found then
      return refused('illegal', 'No item you are offering is marked unacceptable, so the native Stop Asking path does '
        ..'not apply; mark one with deal_item_unacceptable first', {otherPlayerId = other})
    end
  end
  if (operation == 'deal_reject' or operation == 'deal_adjust') and session == nil and pending ~= true then
    return refused('stale', 'No open session and no pending deal with this player, so there is nothing to answer; '
      ..'re-read civ.decisions', {otherPlayerId = other})
  end
  local note
  if operation == 'deal_balance' then
    note = 'EQUALIZE is the native "make this deal more equitable" request: it asks the engine what it would take and '
      ..'edits the outgoing draft only. It never accepts a deal and never spends anything. The counterpart answers '
      ..'asynchronously, so re-read the deal before sending anything else.'
  elseif operation == 'deal_accept' then
    note = 'The native ACCEPTED request was queued. Submission is not completion: re-observe to confirm the deal was '
      ..'enacted and read the counterpart\'s statement for the outcome.'
  else
    note = 'The native '..actionName..' request was queued for the engine. Submission is not completion: the '
      ..'counterpart answers asynchronously through the diplomacy statement stream, and observed below is a fresh read.'
  end
  local result = submit({mutation('SendWorkingDeal '..actionName, DealManager, 'DealManager', 'SendWorkingDeal',
    function() return DealManager.SendWorkingDeal(action, ctx.pid, other) end)}, note)
  result.otherPlayerId = other
  result.dealAction = actionName
  result.requested = {
    pending = pending, equal = equal, sessionId = session or A.null,
  }
  return finish(ctx, result, session, other)
end

-- ---------------------------------------------------------------------------
-- Dispatcher.
-- ---------------------------------------------------------------------------
local function pickOption(record, choice)
  for _, option in ipairs(record.options or {}) do
    if type(option.choice) == 'string' and option.choice == choice then return option end
  end
  return nil
end

function A.diplomacyAction(ctx, args, record)
  args = args or {}
  local operation = text(args.operation)
  -- The decision id path may omit operation: the record already names the one action its row is
  -- about (an openings row is `open`, a session row is `response`), so the choice is not guessed.
  if operation == nil and record ~= nil then operation = text(record.operation) end
  if operation == nil and (args.key ~= nil or args.choice ~= nil) then operation = 'response' end
  assert(operation ~= nil, 'diplomacy action needs operation. '..OPERATION_HELP)
  -- The id-based path (civ.decide) validates the echoed choice against the option list the model
  -- read. Only when that list came from the native tables: the generic fallback is not a complete
  -- list and must not reject a key the engine would accept.
  if record ~= nil and record.selectionSource == 'native_diplomacy_tables'
    and (operation == 'response' or operation == 'statement') then
    local key = text(args.key) or text(args.choice)
    assert(key ~= nil, 'This decision needs choice=<selection key>')
    if operation == 'response' then
      local option = pickOption(record, key)
      assert(option ~= nil and option.available, 'choice must be an available selection key from this session')
    else
      assert(pickOption(record, key) ~= nil or pickOption(record, 'CHOICE_'..key) ~= nil,
        'key must be a statement this session offers; list them with civ.decisions(id=...)')
    end
  end
  local result
  if operation == 'open' then result = submitOpen(ctx, args, record)
  elseif operation == 'response' or operation == 'statement' or operation == 'close' then
    result = submitSession(ctx, args, record, operation)
  elseif operation == 'deal_item_add' then result = submitItemAdd(ctx, args, record)
  elseif operation == 'deal_item_set' then result = submitItemSet(ctx, args, record)
  elseif operation == 'deal_item_remove' then result = submitItemRemove(ctx, args, record)
  elseif operation == 'deal_item_unacceptable' then result = submitItemUnacceptable(ctx, args, record)
  elseif operation == 'deal_clear' or operation == 'deal_copy_incoming' then
    result = submitDraft(ctx, args, record, operation)
  elseif operation == 'deal_balance' or operation == 'deal_propose' or operation == 'deal_adjust'
    or operation == 'deal_demand' or operation == 'deal_accept' or operation == 'deal_reject'
    or operation == 'deal_reject_permanent' or operation == 'deal_close' then
    result = submitDealRequest(ctx, args, record, operation)
  else
    error('Unsupported diplomacy operation: '..tostring(operation)..'. '..OPERATION_HELP)
  end
  result.operation = operation
  if result.otherPlayerId == nil then result.otherPlayerId = A.null end
  return result
end

-- ---------------------------------------------------------------------------
-- Published schema. civ.probe reads this table, so an entry means the bridge can really submit it.
-- ---------------------------------------------------------------------------
A.diplomacyActionSpec = {
  operations = allOperations(),
  -- Published once by civ.probe (capabilities.decisionKinds), not reprinted on every record a
  -- decisions list happens to contain.
  help = OPERATION_HELP,
  fields = {
    operation = 'string',
    playerId = 'the other player id from civ.decisions. Required for open and every deal operation; optional for '
      ..'response/statement/close, where the open session (or the decide record) identifies the counterpart',
    sessionId = 'the session id from civ.decisions. Required for response/statement/close unless the pair has exactly '
      ..'one open session; a session operation that carries only sessionId derives the counterpart from that session',
    key = 'selection key from the record options, or an opening key from the openings record (open)',
    itemType = 'DealItemTypes member: '..table.concat(ITEM_TYPE_ORDER, '|')..' (deal_item_add)',
    itemId = 'deal item id from the record deal items (deal_item_set/remove/unacceptable)',
    from = 'me|them, or the player id of the offering side (default me)',
    subType = 'agreement type id (DealAgreementTypes) or city subtype from the catalogue entry',
    subTypeName = 'agreement type name, e.g. MAKE_PEACE|OPEN_BORDERS|RESEARCH_AGREEMENT|ALLIANCE|JOINT_WAR',
    valueType = 'engine value type id of the item from the catalogue entry (resource, city, great work or agreement value)',
    amount = 'integer 1..the item\'s GetMaxAmount',
    duration = 'turns (0 = one time)',
    warType = 'WarTypes member for a joint or third-party war agreement',
  },
  native = 'DiplomacyManager.RequestSession/AddResponse/AddStatement/CloseSession for sessions; DealManager.'
    ..'GetWorkingDeal/GetPossibleDealItems/SendWorkingDeal/AreWorkingDealsEqual/HasPendingDeal/ClearWorkingDeal/'
    ..'CopyIncomingToOutgoingWorkingDeal plus the DiplomacyDeal and DiplomacyDealItem methods the DiplomacyDealView '
    ..'click handlers use. EQUALIZE is the native "make this deal more equitable" request: it edits the draft and never '
    ..'accepts or spends. ACCEPTED is only sent while AreWorkingDealsEqual is true.',
}

-- The action-type table is published by decisions.lua. When this module happens to load after it, the
-- entry is filled in here so the surface is identical either way (same table, filled only if empty).
if A.decisionActionTypes ~= nil and A.decisionActionTypes.diplomacy == nil then
  A.decisionActionTypes.diplomacy = A.diplomacyActionSpec
end
