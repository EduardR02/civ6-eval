import { expect, test } from "bun:test";
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from "fengari";
import { parse } from "luaparse";

const decisionsSource = await Bun.file("lua/decisions.lua").text();
const diplomacySource = (await Bun.file("lua/diplomacy.lua").exists())
  ? await Bun.file("lua/diplomacy.lua").text()
  : null;

// Production load order: common, state, actions/options, diplomacy, decisions. The diplomacy module
// is optional in this decisions-focused harness; every diplomacy assertion below drives it through
// an explicit stub, so the family is tested here for its delegation contract, not its internals.
const sources = [
  await Bun.file("test/lua/shim.lua").text(),
  await Bun.file("test/lua/fixture.lua").text(),
  await Bun.file("lua/common.lua").text(),
  await Bun.file("lua/state.lua").text(),
  ...(diplomacySource === null ? [] : [diplomacySource]),
  decisionsSource,
];

// The existing fixture models Lua-visible objects only; it cannot simulate native access violations.
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

test("decision collectors remain valid Civ Lua 5.1", () => {
  expect(parse(decisionsSource, { luaVersion: "5.1" }).type).toBe("Chunk");
});

test("missing native managers report degradation without aborting other decision families", () => {
  scenario(`
    local A = AstraCiv
    local function absent() return nil end
    Game.GetEras, Game.GetGreatPeople, Game.GetWorldCongress, Game.GetReligion = absent, absent, absent, absent
    Players[0].GetReligion, Players[0].GetGovernors = absent, absent
    Players[0].GetCities, Players[0].GetUnits, Players[0].GetDiplomacy = absent, absent, absent
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_PRODUCTION}
    local result = A.decisions({detail='full'})
    assert(result.total == 1 and result.decisions[1].kind == 'blocker')
    assert(result.decisions[1].id == 'test:decision:blocker:ENDTURN_BLOCKING_PRODUCTION')
    for group, key in pairs({commemoration='GetEras', greatPeople='GetGreatPeople', congress='GetWorldCongress',
      pantheon='GetReligion', religion='GetReligion', governors='GetGovernors', cityFate='GetCities',
      espionage='GetUnits'}) do
      assert(A.diagnostics[group] and A.diagnostics[group][key], group..' lost its null-manager diagnostic')
    end
    assert(A.diagnostics.decisions == nil, 'A collector threw instead of degrading locally')
  `);
});

test("dedication choice reads wait for a positive allowance and preserve the available decision", () => {
  scenario(`
    local A, allowed, queried = AstraCiv, 0, 0
    GameConfiguration.GetStartTurn = function() return 0 end
    local eras = {
      GetPlayerNumAllowedCommemorations=function() return allowed end,
      GetPlayerCommemorateChoices=function() queried=queried+1; return {4} end,
      GetCurrentEra=function() return 2 end,
      GetPlayerActiveCommemorations=function() return {} end,
      HasGoldenAge=function() return false end, HasHeroicGoldenAge=function() return false end, HasDarkAge=function() return true end,
    }
    Game.GetEras = function() return eras end
    GameInfo.CommemorationTypes = {[4]={CommemorationType='COMMEMORATION_TEST', CategoryDescription='Dedication'}}
    assert(A.decisions({kind='commemoration'}).total == 0)
    assert(queried == 0, 'An inactive era queried the unsafe choices manager')
    allowed = 1
    local record = A.decisions({kind='commemoration', detail='full'}).decisions[1]
    assert(queried == 1 and record.id == 'test:decision:commemoration:era2')
    assert(record.operations[1] == 'choose')
    assert(record.options[1].choice == 'COMMEMORATION_TEST' and record.selectCount == 1)
  `);
});

test("congress defers meeting and favor reads until a ballot or emergency exists", () => {
  scenario(`
    local A, stage, costs, status, favor = AstraCiv, 0, 0, 0, 0
    local proposals = {empty={ProposalsOfType={}}}
    GameCapabilities = {HasCapability=function() return true end}
    GlobalParameters = {WORLD_CONGRESS_INITIAL_ERA=2}
    Game.GetEras = function() return {GetCurrentEra=function() return 2 end} end
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return stage end
    local congress = {
      GetEmergencies=function() return {Proposals=proposals} end,
      GetProposals=function() return {Proposals=proposals} end,
      GetResolutions=function() return {} end,
      GetMeetingStatus=function() status=status+1; return {TurnsLeft=12} end,
      GetVotesandFavorCost=function() costs=costs+1; return {[0]=10, MaxVotes=5} end,
    }
    Game.GetWorldCongress=function() return congress end
    Players[0].GetFavor=function() favor=favor+1; return 25 end
    assert(A.decisions({kind='congress'}).total == 0)
    assert(costs == 0 and status == 0 and favor == 0)
    stage = 1
    assert(A.decisions({kind='congress'}).total == 0)
    assert(costs == 0 and status == 0 and favor == 0)
    proposals = {category={ProposalsOfType={
      b={TypeName='B', Type=2, Target=3, Sender=0, Name='Second'},
      a={TypeName='A', Type=1, Target=2, Sender=0, Name='First'},
    }}}
    stage = 0
    local emergency = A.decisions({kind='congress', detail='full'}).decisions[1]
    assert(emergency.id == 'test:decision:congress:proposals:turn10' and emergency.operation == 'proposal')
    assert(emergency.turnsToNextSession == 12 and emergency.favor == 25)
    assert(emergency.options[1].label == 'First' and emergency.options[2].choice.discussionType == 2)
    assert(costs == 0 and status == 1 and favor == 1)
    stage = 2
    local ballot = A.decisions({kind='congress', detail='full'}).decisions[1]
    assert(ballot.id == 'test:decision:congress:session:stage2:turn10' and ballot.operation == 'vote')
    assert(ballot.maxVotes == 5 and ballot.options[1].choice.target == 2)
    assert(costs == 1 and status == 1 and favor == 2)
    PlayerOperations.WORLD_CONGRESS_DISCUSSION_VOTE = 9001
    PlayerOperations.PARAM_PLAYER_ONE, PlayerOperations.PARAM_PLAYER_TWO = 'sender', 'target'
    PlayerOperations.PARAM_WORLD_CONGRESS_VOTES = 'votes'
    local result = A.decisionAction({type='congress', operation='vote', votes={{subject='discussion', sender=0, target=2, votes=1}}})
    assert(result.accepted and result.submittedCount == 1 and STUB_REQUEST_INDEX == 1)
    proposals.category.ProposalsOfType.a.Disabled = true
    local ok = pcall(A.decisionAction, {type='congress', operation='vote', votes={{subject='discussion', sender=0, target=2, votes=1}}})
    assert(not ok and STUB_REQUEST_INDEX == 1, 'Disabled ballot entry was submitted')
  `);
});

test("congress publishes targets, decodes favor prices and refuses an unpayable ballot before submission", () => {
  scenario(`
    local A, segment, favor = AstraCiv, 31, 60
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name)
      if name == 'TURNSEG_WORLDCONGRESS_1' then return 31 end
      if name == 'TURNSEG_WORLDCONGRESS_2' then return 32 end
      return 33
    end}
    Game.GetCurrentTurnSegment = function() return segment end
    GameInfo.Resolutions = {
      [0]={Index=0, Hash=4000, ResolutionType='RESOLUTION_TEST', Name='LOC_RES',
        Effect1Description='LOC_EFFECT_A', Effect2Description='LOC_EFFECT_B'},
      ['RESOLUTION_TEST']={Index=0, Hash=4000, ResolutionType='RESOLUTION_TEST', Name='LOC_RES',
        Effect1Description='LOC_EFFECT_A', Effect2Description='LOC_EFFECT_B'},
    }
    GameInfo.ProposalTypes = {[7]={Index=7, ProposalType='PROPOSAL_TEST', Name='LOC_PROPOSAL', Sort=1}}
    GameInfo.VotingBlockers = {}
    local resolutions = {Stage=3, [0]={Type='RESOLUTION_TEST', TargetType='PlayerType',
      PossibleTargets={[1]=2, [2]=0}, FavoredPlayerIDs={2}, DisfavoredPlayerIDs={0}}}
    local proposals = {[7]={ProposalsOfType={
      {TypeName='PROPOSAL_TEST', Type=7, Sender=2, Target=0, Name='LOC_DISCUSSION', Description='LOC_DESC'},
    }}, FavorCost={[0]=10,[1]=25,[2]=45, MaxVotes=2}}
    local congress = {
      GetResolutions=function() return resolutions end,
      GetProposals=function() return {Proposals=proposals} end,
      GetVotesandFavorCost=function() return {[0]=10,[1]=25,[2]=45, MaxVotes=2} end,
      IsInSession=function() return true end,
    }
    Game.GetWorldCongress=function() return congress end
    Players[0].GetFavor=function() return favor end
    local record = A.decisions({kind='congress', detail='full'}).decisions[1]
    assert(record.stage == 1 and record.stageName == 'regular_session' and record.maxVotes == 2)
    assert(record.favor == 60 and record.favorCostByVotes[2] == 25 and record.favorCostPerVote[2] == 15)
    assert(#record.options == 2)
    local resolution = record.options[1]
    assert(resolution.subject == 'resolution' and resolution.available)
    assert(#resolution.targets == 2 and resolution.targets[1].selection == 0 and resolution.targets[2].targetIndex == 2)
    assert(resolution.targets[1].playerId == 2 and resolution.targets[1].label == 'LOC_TEST_CITY_STATE_NAME')
    local discussion = record.options[2]
    assert(discussion.subject == 'discussion' and discussion.senderName == 'LOC_TEST_CITY_STATE_NAME')
    assert(discussion.targetName == 'CIVILIZATION_TEST')
    assert(discussion.choice.votes == 1 and discussion.target == 0)
    PlayerOperations.WORLD_CONGRESS_RESOLUTION_VOTE = 9002
    PlayerOperations.WORLD_CONGRESS_DISCUSSION_VOTE = 9003
    PlayerOperations.PARAM_RESOLUTION_TYPE, PlayerOperations.PARAM_WORLD_CONGRESS_VOTES = 'res', 'votes'
    PlayerOperations.PARAM_RESOLUTION_OPTION, PlayerOperations.PARAM_RESOLUTION_SELECTION = 'option', 'selection'
    PlayerOperations.PARAM_PLAYER_ONE, PlayerOperations.PARAM_PLAYER_TWO = 'one', 'two'
    -- One resolution (2 votes, cumulative 25) plus one opposing discussion vote (10) is 35 <= 60.
    local ballot = A.decisionAction({type='congress', operation='vote', votes={
      {subject='resolution', resolution='RESOLUTION_TEST', option=1, selection=1, votes=2},
      {subject='discussion', sender=2, target=0, votes=-1},
    }})
    assert(ballot.accepted and ballot.submittedCount == 2 and ballot.favorCost == 35)
    local calls = 0
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' then
        calls = calls + 1
        if calls == 1 then
          assert(entry.data.operation == 9002)
          assert(entry.data.parameters['res'] == 4000 and entry.data.parameters['votes'] == 2)
          assert(entry.data.parameters['option'] == 1 and entry.data.parameters['selection'] == 1)
        else
          assert(entry.data.operation == 9003 and entry.data.parameters['votes'] == -1)
        end
      end
    end
    assert(calls == 2)
    -- The engine's own price table bounds the ballot: 3 votes on one resolution is unaffordable here.
    STUB_REQUEST_INDEX = 0
    local before = STUB_REQUEST_INDEX
    local tooMany = pcall(A.decisionAction, {type='congress', operation='vote', votes={
      {subject='resolution', resolution='RESOLUTION_TEST', option=1, selection=0, votes=3}}})
    assert(not tooMany and STUB_REQUEST_INDEX == before, 'A vote above MaxVotes was submitted')
    -- Out-of-range targets and disabled entries never reach the engine either.
    local badTarget = pcall(A.decisionAction, {type='congress', operation='vote', votes={
      {subject='resolution', resolution='RESOLUTION_TEST', option=1, selection=2, votes=1}}})
    assert(not badTarget and STUB_REQUEST_INDEX == before)
    proposals[7].ProposalsOfType[1].Disabled = true
    local disabled = pcall(A.decisionAction, {type='congress', operation='vote', votes={
      {subject='discussion', sender=2, target=0, votes=1}}})
    assert(not disabled and STUB_REQUEST_INDEX == before)
    proposals[7].ProposalsOfType[1].Disabled = false
    favor = 20
    local unaffordable = A.decisionAction({type='congress', operation='vote', votes={
      {subject='resolution', resolution='RESOLUTION_TEST', option=1, selection=0, votes=2}}})
    assert(not unaffordable.accepted and unaffordable.status == 'illegal')
    assert(unaffordable.favor == 20 and unaffordable.favorCost == 25 and STUB_REQUEST_INDEX == before)
  `);
});

test("congress submit performs the native Accept sequence and reports the ballot it sent", () => {
  scenario(`
    local A, segment = AstraCiv, 31
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name)
      if name == 'TURNSEG_WORLDCONGRESS_1' then return 31 end
      if name == 'TURNSEG_WORLDCONGRESS_2' then return 32 end
      return 33
    end}
    Game.GetCurrentTurnSegment = function() return segment end
    local proposals = {[7]={ProposalsOfType={{TypeName='PROPOSAL_TEST', Type=7, Sender=2, Target=0, Name='LOC_D'}}}}
    local emergencies = {[7]={ProposalsOfType={}}}
    GameInfo.ProposalTypes = {[7]={Index=7, Name='LOC_PROPOSAL', Sort=1}}
    local congress = {
      IsInSession=function() return segment == 31 or segment == 32 end,
      GetProposals=function() return {Proposals=proposals} end,
      GetResolutions=function() return {} end,
      GetVotesandFavorCost=function() return {[0]=10, [1]=25, MaxVotes=2} end,
      GetEmergencies=function() return {Proposals=emergencies} end,
      GetMeetingStatus=function() return {TurnsLeft=4} end,
    }
    Game.GetWorldCongress=function() return congress end
    Players[0].GetFavor=function() return 40 end
    PlayerOperations.WORLD_CONGRESS_SUBMIT_TURN = 9004
    PlayerOperations.WORLD_CONGRESS_LOOKED_AT_AVAILABLE = 9005
    PlayerOperations.WORLD_CONGRESS_DISCUSSION_SELECTION = 9006
    PlayerOperations.PARAM_OTHER_PLAYER, PlayerOperations.PARAM_DISCUSSION_TYPE = 'other', 'discussion'
    -- A congress segment clears both ordinary command flags, so only the congress family is ready.
    STUB_ALLOW_STRATEGIC, STUB_ALLOW_TACTICAL = false, false
    assert(A.decisionReady('congress') and not A.decisionReady('unit_operation'))
    -- Submit is the whole native Accept: release the segment and end the turn, in that order.
    local plain = A.decisionAction({type='congress', operation='submit'})
    assert(plain.accepted and plain.requestCount == 2 and plain.submittedCount == 2)
    assert(plain.requests[1].request == 'WORLD_CONGRESS_SUBMIT_TURN')
    assert(plain.requests[2].request == 'ACTION_ENDTURN' and STUB_SUBMITTED)
    assert(plain.turnEnding == true and plain.sessionSubmitted == true and plain.popup == 'popup:world-congress')
    assert(plain.observed.stage == 1 and plain.observed.stageName == 'regular_session')
    assert(plain.observed.inSession == true)
    assert(#plain.ballot == 0, 'No votes were supplied, so the ballot readback must be empty')
    -- The module publishes exactly which decision actions end the turn, so a batch can keep them last.
    assert(A.decisionEndsTurn({type='congress', operation='submit'}))
    assert(not A.decisionEndsTurn({type='congress', operation='vote'}))
    assert(not A.decisionEndsTurn({type='congress', operation='proposal'}) and not A.decisionEndsTurn({type='envoy', operation='send'}))
    local actions = 0
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestAction' then actions = actions + 1; assert(entry.data.action == ActionTypes.ACTION_ENDTURN) end
    end
    assert(actions == 1)
    -- Votes passed to submit are sent first, then the segment request and the end-turn request.
    STUB_REQUEST_INDEX = 0
    PlayerOperations.WORLD_CONGRESS_DISCUSSION_VOTE = 9010
    PlayerOperations.PARAM_PLAYER_ONE, PlayerOperations.PARAM_PLAYER_TWO = 'one', 'two'
    PlayerOperations.PARAM_WORLD_CONGRESS_VOTES = 'votes'
    local withVotes = A.decisionAction({type='congress', operation='submit',
      votes={{subject='discussion', sender=2, target=0, votes=2}}})
    assert(withVotes.accepted and withVotes.requestCount == 3 and withVotes.submittedCount == 3)
    assert(withVotes.requests[1].request == 'WORLD_CONGRESS_DISCUSSION_VOTE 2->0')
    assert(withVotes.requests[2].request == 'WORLD_CONGRESS_SUBMIT_TURN' and withVotes.requests[3].request == 'ACTION_ENDTURN')
    assert(#withVotes.ballot == 1 and withVotes.ballot[1].votes == 2 and withVotes.ballot[1].favorCost == 25)
    assert(withVotes.favorCost == 25 and withVotes.favor == 40, 'the favor price of the submitted ballot must be reported')
    -- The native Accept sends one request per resolution: a duplicate is refused before anything.
    STUB_REQUEST_INDEX = 0
    local duplicate = pcall(A.decisionAction, {type='congress', operation='submit', votes={
      {subject='discussion', sender=2, target=0, votes=1}, {subject='discussion', sender=2, target=0, votes=-1}}})
    assert(not duplicate and STUB_REQUEST_INDEX == 0, 'A duplicated discussion was submitted twice')
    -- The results segment is not a voting segment: the look acknowledgement and proposals work, votes do not.
    segment = 33
    STUB_REQUEST_INDEX = 0
    local noVote = pcall(A.decisionAction, {type='congress', operation='vote', votes={{subject='discussion', sender=2, target=0, votes=1}}})
    assert(not noVote and STUB_REQUEST_INDEX == 0)
    local looked = A.decisionAction({type='congress', operation='looked'})
    assert(looked.accepted and looked.observed.stage == 4 and looked.observed.stageName == 'results')
    assert(STUB_REQUEST_INDEX == 1)
    -- One proposal per target player, exactly as the native proposals tab disables duplicates.
    emergencies[7].ProposalsOfType = {{TypeName='PROPOSAL_TEST', Type=7, Target=0, Name='LOC_A'}}
    local duplicate = pcall(A.decisionAction, {type='congress', operation='proposal', proposals={
      {target=0, discussionType=7}, {target=0, discussionType=7}}})
    assert(not duplicate and STUB_REQUEST_INDEX == 1, 'Two proposals for one target were submitted')
    local single = A.decisionAction({type='congress', operation='proposal', proposals={{target=0, discussionType=7}}})
    assert(single.accepted and single.submittedCount == 1 and STUB_REQUEST_INDEX == 2)
  `);
});

test("the results segment shows the native review even when there is nothing to propose", () => {
  scenario(`
    local A, segment = AstraCiv, 33
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name)
      if name == 'TURNSEG_WORLDCONGRESS_1' then return 31 end
      if name == 'TURNSEG_WORLDCONGRESS_2' then return 32 end
      return 33
    end}
    Game.GetCurrentTurnSegment = function() return segment end
    GameInfo.Resolutions = {
      [0]={Index=0, Hash=4000, ResolutionType='RESOLUTION_TEST', Name='LOC_RES'},
      ['RESOLUTION_TEST']={Index=0, Hash=4000, ResolutionType='RESOLUTION_TEST', Name='LOC_RES'},
    }
    local review = {Resolutions={Stage=3, [0]={Type='RESOLUTION_TEST', TargetType='PlayerType', ChosenThing=2,
      ChosenOption='LOC_CHOSEN', ChosenLabel='LOC_LABEL', IsNew=true,
      PlayerSelections={[0]={OptionChosen=1, Votes=3}, [2]={OptionChosen=2, Votes=1}}}}}
    Game.GetWorldCongress=function() return {
      GetEmergencies=function() return {Proposals={}} end,
      GetMeetingStatus=function() return {TurnsLeft=7} end,
      GetReview=function() return review end,
      IsInSession=function() return false end,
    } end
    local records = A.decisions({kind='congress', detail='full'}).decisions
    assert(#records == 1 and records[1].operation == 'review', 'the results segment hid the review')
    local record = records[1]
    assert(record.stage == 4 and record.stageName == 'results' and record.turnsToNextSession == 7)
    assert(#record.resolutions == 1)
    local resolution = record.resolutions[1]
    assert(resolution.resolution == 'RESOLUTION_TEST' and resolution.label == 'LOC_RES')
    assert(resolution.outcome == 'LOC_CHOSEN' and resolution.outcomeLabel == 'LOC_LABEL')
    assert(resolution.votesOption1 == 3 and resolution.votesOption2 == 1 and not resolution.tied)
    assert(resolution.chosenTarget == 'LOC_TEST_CITY_STATE_NAME' and resolution.isNew)
    assert(#record.options == 0 and #record.operations == 0, 'the review record is informational')
    -- There is nothing to decide here, so civ.decide must not pretend otherwise.
    local decided = pcall(A.decide, {id=record.id, choice='anything'})
    assert(not decided and STUB_REQUEST_INDEX == 0)
  `);
});

test("pre-era congress needs a live emergency notification and stale proposals never submit", () => {
  scenario(`
    local A, reads, dismissed = AstraCiv, 0, false
    GameCapabilities = {HasCapability=function() return true end}
    GlobalParameters = {WORLD_CONGRESS_INITIAL_ERA=2}
    Game.GetEras = function() return {GetCurrentEra=function() return 0 end} end
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return 0 end
    local proposal = {TypeName='A', Type=1, Target=2}
    Game.GetWorldCongress = function() return {
      GetEmergencies=function() reads=reads+1; return {Proposals={category={ProposalsOfType={proposal}}}} end,
      GetMeetingStatus=function() return {} end,
    } end
    assert(A.decisions({kind='congress'}).total == 0 and reads == 0)
    NotificationTypes = {NOTIFICATION_WORLD_CONGRESS_SPECIAL_SESSION_NON_BLOCKING=42}
    A.notificationIds[0] = {[7]=true}
    NotificationManager.Find = function() return {
      IsDismissed=function() return dismissed end, GetType=function() return 42 end,
    } end
    assert(A.decisions({kind='congress'}).total == 1 and reads == 1)
    local ok = pcall(A.decisionAction, {type='congress', operation='submit'})
    assert(not ok and STUB_REQUEST_INDEX == 0)
    proposal.Disabled = true
    ok = pcall(A.decisionAction, {type='congress', operation='proposal', proposals={{target=2, discussionType=1}}})
    assert(not ok and STUB_REQUEST_INDEX == 0)
    dismissed = true
    local before = reads
    assert(A.decisions({kind='congress'}).total == 0 and reads == before)
  `);
});

test("governor promotions come from the native GovernorPromotionSets relationship", () => {
  scenario(`
    local A = AstraCiv
    -- The installed ruleset has no GovernorType column on GovernorPromotions; membership is the set
    -- table (Expansion2_Schema.sql:372-379 versus :402-407). A row advertised for another governor
    -- must not appear, and the base ability is not an earnable promotion.
    local function rows(defs)
      local out, index = {}, 0
      for _, row in ipairs(defs) do
        out[row.Index] = row
        out[row.GovernorPromotionType] = row
      end
      return setmetatable(out, {__call = function() index = index + 1; return defs[index] end})
    end
    GameInfo.GovernorPromotions = rows({
      {Index=0, Hash=3600, GovernorPromotionType='GOVERNOR_PROMOTION_BASE', BaseAbility=true, Level=0, Column=0, Name='LOC_BASE'},
      {Index=1, Hash=3601, GovernorPromotionType='GOVERNOR_PROMOTION_TEST', Level=1, Column=1, Name='LOC_LEGIT', Description='LOC_LEGIT_DESC'},
      {Index=2, Hash=3602, GovernorPromotionType='GOVERNOR_PROMOTION_OTHER', Level=1, Column=1, Name='LOC_OTHER'},
    })
    GameInfo.GovernorPromotionSets = function() return coroutine.wrap(function()
      coroutine.yield({GovernorType='GOVERNOR_AMANI', GovernorPromotion='GOVERNOR_PROMOTION_BASE'})
      coroutine.yield({GovernorType='GOVERNOR_AMANI', GovernorPromotion='GOVERNOR_PROMOTION_TEST'})
      coroutine.yield({GovernorType='GOVERNOR_MAGNUS', GovernorPromotion='GOVERNOR_PROMOTION_OTHER'})
    end) end
    GameInfo.GovernorPromotionPrereqs = function() return coroutine.wrap(function() end) end
    STUB_GOVERNOR_PROMOTABLE = true
    local promote
    for _, record in ipairs(A.decisions({kind='governor', detail='full'}).decisions) do
      if record.operation == 'promote' then promote = record end
    end
    assert(promote ~= nil, 'No promote decision was published for an appointed governor with a title')
    assert(promote.governor == 'GOVERNOR_AMANI' and promote.promotionSet == 'GovernorPromotionSets')
    assert(#promote.options == 1 and promote.options[1].choice == 'GOVERNOR_PROMOTION_TEST')
    assert(promote.options[1].available and not promote.options[1].owned)
    local answer = A.decide({id=promote.id, choice='GOVERNOR_PROMOTION_TEST'})
    assert(answer.accepted and answer.submittedCount == 1)
    local sent
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' then sent = entry.data end
    end
    -- Parameters are row Indexes (GovernorPanel.lua:551-576); the legality calls took Hashes.
    assert(sent.operation == PlayerOperations.PROMOTE_GOVERNOR)
    assert(sent.parameters[PlayerOperations.PARAM_GOVERNOR_TYPE] == 0)
    assert(sent.parameters[PlayerOperations.PARAM_GOVERNOR_PROMOTION_TYPE] == 1)
    -- A promotion that belongs to another governor is not offered at all.
    local wrong = pcall(A.decide, {id=promote.id, choice='GOVERNOR_PROMOTION_OTHER'})
    assert(not wrong and STUB_REQUEST_INDEX == 1, 'A foreign promotion was submitted')
  `);
});

test("unappointed governors never enter promotion or assignment legality", () => {
  scenario(`
    STUB_GOVERNOR_APPOINTED = false
    local queries = 0
    local governors = Players[0]:GetGovernors()
    governors.GetGovernor = function() queries=queries+1; return nil end
    governors.CanPromoteGovernor = function() queries=queries+1; return true end
    governors.CanAssignGovernor = function() queries=queries+1; return true end
    local result = AstraCiv.decisions({kind='governor', detail='full'})
    assert(queries == 0)
    assert(result.total == 1 and result.decisions[1].operation == 'appoint')
    assert(result.decisions[1].options[1].choice == 'GOVERNOR_AMANI')
    assert(result.decisions[1].options[2].choice == 'GOVERNOR_MAGNUS')
  `);
});

test("governor assignments retain valid destinations while marking missing collections partial", () => {
  scenario(`
    local A = AstraCiv
    local complete = A.decisions({kind='governor', detail='full'}).decisions[2]
    assert(complete.id == 'test:decision:governor:assign:GOVERNOR_AMANI')
    assert(complete.candidatesPartial == false)
    assert(complete.options[1].choice == 'test:city:0:3' and complete.options[2].choice == 'test:city:2:11')
    Players[2].GetCities = function() return nil end
    A.begin()
    local partial = A.decisions({kind='governor', detail='full'}).decisions[2]
    assert(partial.candidatesPartial and #partial.options == 1 and partial.options[1].choice == 'test:city:0:3')
    assert(A.diagnostics.governors.minorCities)
    assert(A.diagnostics.decisions == nil)
    Players[0].GetCities = function() return nil end
    A.begin()
    local missing = A.decisions({kind='governor', detail='full'})
    assert(missing.total == 1 and missing.decisions[1].operation == 'appoint')
    assert(A.diagnostics.governors.GetCities)
  `);
});

test("a governor destination that resolves to a different city is refused before legality or mutation", () => {
  scenario(`
    local A = AstraCiv
    -- The fixture's minor city is a legal Amani destination; the engine then hands back a live object
    -- with a different owner/id, exactly like the seven mismatched lookups in the reviewed run.
    local record = A.decisions({kind='governor', detail='full'}).decisions[2]
    assert(record.options[2].choice == 'test:city:2:11')
    local ownCity = Players[0]:GetCities():FindID(3)
    CityManager.GetCity = function() return ownCity end
    A.begin()
    local answer = A.decide({id=record.id, choice='test:city:2:11'})
    assert(not answer.accepted and answer.status == 'stale', 'A mismatched city id was accepted: '..tostring(answer.status))
    assert(answer.reasons[1]:find('different entity', 1, true) ~= nil, tostring(answer.reasons[1]))
    assert(STUB_REQUEST_INDEX == 0 and A.diagnostics.identity.city)
  `);
});

test("great person claims pass the timeline individual through and report patronage prices", () => {
  scenario(`
    local A = AstraCiv
    GameInfo.GreatPersonIndividuals = {
      [7]={Index=7, Hash=5000, GreatPersonIndividualType='GREAT_PERSON_INDIVIDUAL_TEST',
        Name='LOC_GP_NAME', ActionCharges=1},
      ['GREAT_PERSON_INDIVIDUAL_TEST']={Index=7, Hash=5000, GreatPersonIndividualType='GREAT_PERSON_INDIVIDUAL_TEST',
        Name='LOC_GP_NAME', ActionCharges=1},
    }
    GameInfo.GreatPersonClasses = {[0]={Index=0, GreatPersonClassType='GREAT_PERSON_CLASS_TEST'}}
    GameInfo.Eras = {[0]={Index=0, EraType='ERA_ANCIENT'}}
    local timeline = {{Individual='GREAT_PERSON_INDIVIDUAL_TEST', Class=0, Era=0, Cost=100,
      ActionNameText='LOC_ACTION', ActionEffectText='LOC_EFFECT', PassiveEffectText='LOC_PASSIVE'}}
    local claims = {}
    local people = {
      GetTimeline=function() return timeline end,
      CanRecruitPerson=function(self, pid, individual) claims[#claims+1]={ 'recruit', individual }; return individual == 'GREAT_PERSON_INDIVIDUAL_TEST' end,
      CanRejectPerson=function() return false end,
      GetRejectCost=function() return 999 end,
      CanPatronizePerson=function(self, pid, individual, yield)
        claims[#claims+1]={ 'patronize', individual, yield }
        return yield == YieldTypes.GOLD
      end,
      GetPatronizeCost=function(self, pid, individual, yield)
        if yield == YieldTypes.GOLD then return 500 end
        return 1000000
      end,
      GetEarnConditionsText=function() return 'LOC_EARN' end,
    }
    Game.GetGreatPeople=function() return people end
    GameCapabilities = {HasCapability=function(name) return name ~= 'CAPABILITY_GREAT_PEOPLE_CAN_REJECT' end}
    local record = A.decisions({kind='great_person', detail='full'}).decisions[1]
    -- The individual is the timeline's own value, not a re-derived row index (7), both in the
    -- legality calls and in the record the caller submits back.
    assert(claims[1][1] == 'recruit' and claims[1][2] == 'GREAT_PERSON_INDIVIDUAL_TEST', 'legality call lost the individual')
    assert(record.individual == 'GREAT_PERSON_INDIVIDUAL_TEST')
    assert(record.individualType == 'GREAT_PERSON_INDIVIDUAL_TEST' and record.individualIndex == 7)
    assert(record.actionCharges == 1 and record.earnConditions == 'LOC_EARN')
    assert(#record.options == 2 and record.options[1].choice == 'recruit' and record.options[1].available)
    assert(record.options[2].choice == 'patronize_gold' and record.options[2].cost == 500)
    assert(record.capabilities.recruit == true and record.capabilities.reject == false)
    assert(record.options[2].engineLegal == true and record.options[2].capability == true)
    local answer = A.decide({id=record.id, choice='patronize_gold'})
    assert(answer.accepted and answer.submittedCount == 1)
    local sent
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' then sent = entry.data end
    end
    assert(sent.operation == PlayerOperations.PATRONIZE_GREAT_PERSON)
    assert(sent.parameters[PlayerOperations.PARAM_GREAT_PERSON_INDIVIDUAL_TYPE] == 'GREAT_PERSON_INDIVIDUAL_TEST')
    assert(sent.parameters[PlayerOperations.PARAM_YIELD_TYPE] == YieldTypes.GOLD)
    STUB_REQUEST_INDEX = 0
    -- Rejection: the engine's legality and the ruleset capability are reported separately, and
    -- availability is the native button state, so a false capability keeps it off without hiding the
    -- engine's own answer or the price.
    people.CanRejectPerson = function() return true end
    people.GetRejectCost = function() return 300 end
    local gated = A.decisions({kind='great_person', detail='full'}).decisions[1]
    local gatedReject
    for _, option in ipairs(gated.options) do
      if option.choice == 'reject' then gatedReject = option end
    end
    assert(gatedReject ~= nil and gatedReject.cost == 300 and gatedReject.currency == 'great_person_points')
    assert(gatedReject.engineLegal == true and gatedReject.capability == false and not gatedReject.available)
    GameCapabilities.HasCapability = function() return true end
    local again = A.decisions({kind='great_person', detail='full'}).decisions[1]
    local reject
    for _, option in ipairs(again.options) do
      if option.choice == 'reject' then reject = option end
    end
    assert(reject ~= nil and reject.available and reject.cost == 300)
    local rejected = A.decisionAction({type='great_person', operation='reject', individual=again.individual})
    assert(rejected.accepted and rejected.submittedCount == 1)
    local rejectRequest
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' and entry.data.operation == PlayerOperations.REJECT_GREAT_PERSON then
        rejectRequest = entry.data
      end
    end
    assert(rejectRequest ~= nil and rejectRequest.parameters[PlayerOperations.PARAM_GREAT_PERSON_INDIVIDUAL_TYPE] == 'GREAT_PERSON_INDIVIDUAL_TEST')
    STUB_REQUEST_INDEX = 0
    local unknown = pcall(A.decisionAction, {type='great_person', operation='recruit', individual='GREAT_PERSON_INDIVIDUAL_OTHER'})
    assert(not unknown and STUB_REQUEST_INDEX == 0, 'An individual outside the timeline was submitted')
  `);
});

test("a pending claim with no legal timeline entry is reported instead of an empty decision list", () => {
  scenario(`
    local A = AstraCiv
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_CLAIM_GREAT_PERSON}
    local timeline = {
      {Individual='GREAT_PERSON_INDIVIDUAL_TAKEN', Class=0, Era=0, Cost=100, Claimant=3},
      {Individual='GREAT_PERSON_INDIVIDUAL_LOCKED', Class=0, Era=0, Cost=200},
    }
    Game.GetGreatPeople=function() return {
      GetTimeline=function() return timeline end,
      CanRecruitPerson=function() return false end,
      CanRejectPerson=function() return false end,
      CanPatronizePerson=function() return false end,
      GetPatronizeCost=function() return 1000000 end,
    } end
    local records = A.decisions({kind='great_person', detail='full'}).decisions
    assert(#records == 1, 'An unresolved claim produced no record')
    local unresolved = records[1]
    assert(unresolved.blocks and unresolved.mandatory and #unresolved.options == 0)
    assert(unresolved.timelineEntries == 2 and #unresolved.timeline == 2)
    assert(unresolved.timeline[1].claimedBy == 3 and unresolved.timeline[2].canRecruit == false)
    assert(A.diagnostics.decisions == nil)
  `);
});

test("spy escape preserves the city-centre route when districts are unavailable and missions reject missing plots", () => {
  scenario(`
    local A = AstraCiv
    local spy = Players[0]:GetUnits():FindID(7)
    local city = Players[0]:GetCities():FindID(3)
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    Players[0]:GetDiplomacy().GetNextEscapingSpyID = function() return 7 end
    Cities.GetPlotPurchaseCity = function() return city end
    city.GetDistricts = function() return nil end
    GameInfo.Districts.DISTRICT_CITY_CENTER = {Index=0, Name='Centre'}
    GameInfo.Districts.DISTRICT_HARBOR = {Index=1, Name='Harbor'}
    local escape = A.decisions({kind='espionage', detail='full'}).decisions[1]
    assert(escape.id == 'test:decision:espionage:escape:7')
    assert(escape.options[1].choice == 'DISTRICT_HARBOR' and not escape.options[1].available)
    assert(escape.options[2].choice == 'DISTRICT_CITY_CENTER' and escape.options[2].available)
    assert(A.diagnostics.espionage.GetDistricts)
    -- A reused slot must not turn the escaping-spy id into a different unit: the collection answers
    -- FindID(7) with a live unit whose own id is 8, and the route must not be built for it.
    local units = Players[0]:GetUnits()
    units.FindID = function(self, id) return spy end
    spy.GetID = function() return 8 end
    A.begin()
    assert(A.decisions({kind='espionage'}).total == 0 and A.diagnostics.identity.unit)
    spy.GetID = function() return 7 end
    units.FindID = function(self, id) return id == 7 and spy or nil end
    STUB_BLOCKERS = {}
    GameInfo.Units[0].Spy = true
    spy.GetSpyOperation = function() return -1 end
    spy.IsReadyToMove = function() return true end
    Map.GetPlot = function() return nil end
    local queried = 0
    UnitManager.CanStartOperation = function() queried=queried+1; return true end
    A.begin()
    assert(A.decisions({kind='espionage'}).total == 0 and queried == 0)
    assert(A.diagnostics.espionage.GetPlot)
  `);
});

test("nullable city offers and the absent diplomacy module never reach native entity methods", () => {
  scenario(`
    local A = AstraCiv
    local cities = Players[0]:GetCities()
    cities.GetNextCapturedCity = function() return nil end
    cities.GetNextRebelledCity = function() return nil end
    local queried = 0
    CityManager.CanStartCommand = function() queried=queried+1; return true end
    local delegated = 0
    A.diplomacyDecisions = function(ctx, out) delegated = delegated + 1; return out end
    assert(AstraCiv.decisions({kind='city_fate'}).total == 0)
    assert(AstraCiv.decisions({kind='diplomacy'}).total == 0 and delegated == 1)
    assert(queried == 0)
  `);
});

test("turn transitions defer blocker bindings without suppressing between-turn congress ballots", () => {
  scenario(`
    local A, calls = AstraCiv, 0
    NotificationManager.GetAllEndTurnBlocking = function() calls=calls+1; return {} end
    NotificationManager.GetFirstEndTurnBlocking = function() calls=calls+1; return -1 end
    STUB_ACTIVE = false
    local result = A.decisions({kind='blocker'})
    assert(calls == 0 and not result.blockersKnown and result.turnState.blockers == A.null)
    STUB_ACTIVE, STUB_PROCESSING = true, true
    result = A.decisions({kind='blocker'})
    assert(calls == 0 and not result.blockersKnown)
    GameCapabilities = {HasCapability=function() return true end}
    DB = {MakeHash=function(name) return name == 'TURNSEG_WORLDCONGRESS_1' and 1 or 2 end}
    Game.GetCurrentTurnSegment = function() return 2 end
    Game.GetWorldCongress = function() return {
      GetProposals=function() return {Proposals={category={ProposalsOfType={
        {TypeName='A', Type=1, Sender=0, Target=2}
      }}}} end,
      GetVotesandFavorCost=function() return {} end,
    } end
    result = A.decisions({kind='congress', detail='full'})
    assert(calls == 0 and result.total == 1 and result.decisions[1].operation == 'vote')
    STUB_PROCESSING = false
    result = A.decisions({kind='blocker'})
    assert(calls == 2 and result.blockersKnown, 'Context and returned turn state must share one blocker observation')
  `);
});

test("dedication initialization gates precede allowance and choice getters", () => {
  scenario(`
    local A, era, start, reads = AstraCiv, 0, 0, 0
    local eras = {
      GetCurrentEra=function() return era end,
      GetPlayerNumAllowedCommemorations=function() reads=reads+1; return 2 end,
      GetPlayerCommemorateChoices=function() reads=reads+1; return {4,5} end,
      GetPlayerActiveCommemorations=function() return {} end,
    }
    Game.GetEras = function() return eras end
    GameConfiguration.GetStartTurn = function() return start end
    GameInfo.CommemorationTypes = {
      [4]={CommemorationType='A'}, [5]={CommemorationType='B'},
    }
    assert(A.decisions({kind='commemoration'}).total == 0 and reads == 0)
    era, start = 2, STUB_TURN
    assert(A.decisions({kind='commemoration'}).total == 0 and reads == 0)
    start = 0
    local record = A.decisions({kind='commemoration', detail='full'}).decisions[1]
    assert(record.selectCount == 2 and #record.options == 2 and reads == 2)
    eras.GetPlayerNumAllowedCommemorations = function() return 0 end
    local ok = pcall(A.decisionAction, {type='commemoration', commemorations={'A'}})
    assert(not ok and STUB_REQUEST_INDEX == 0 and reads == 2)
  `);
});

test("religion founding follows earned beliefs and unknown equipped lists do not invent slots", () => {
  scenario(`
    local A, created, earned, list = AstraCiv, -1, 0, nil
    local religion = Players[0]:GetReligion()
    religion.GetPantheon = function() return 1 end
    religion.GetReligionTypeCreated = function() return created end
    religion.GetNumBeliefsEarned = function() return earned end
    religion.HasReligiousFoundingUnit = function() return earned == 0 end
    local available = false
    local gameReligion = {
      HasBeenFounded=function() return available end,
      IsInSomePantheon=function() return false end,
      IsInSomeReligion=function() return false end,
      IsTooManyForReligion=function() return false end,
      GetReligions=function() return list end,
    }
    Game.GetReligion = function() return gameReligion end
    GameInfo.Religions = function() return coroutine.wrap(function()
      coroutine.yield({Index=1, ReligionType='RELIGION_TEST', Pantheon=false})
    end) end
    GameInfo.Beliefs = function() return coroutine.wrap(function()
      coroutine.yield({Index=2, BeliefType='BELIEF_TEST', BeliefClassType='BELIEF_CLASS_FOLLOWER'})
    end) end
    assert(A.decisions({kind='religion'}).total == 0)
    earned = 2
    local result = A.decisions({kind='religion'})
    assert(result.total == 1 and result.decisions[1].operation == 'found')
    available = nil
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.HasBeenFounded)
    created = 1
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.GetReligions)
    list = {{Founder=0}}
    A.begin()
    assert(A.decisions({kind='religion'}).total == 0 and A.diagnostics.religion.Beliefs)
    list[1].Beliefs = {2}
    result = A.decisions({kind='religion', detail='full'})
    assert(result.total == 1 and result.decisions[1].operation == 'belief' and result.decisions[1].selectCount == 1)
  `);
});

test("unknown spy readiness and failed city legality are reported rather than offered", () => {
  scenario(`
    local A, reads = AstraCiv, 0
    local spy = Players[0]:GetUnits():FindID(7)
    GameInfo.Units[0].Spy = true
    spy.GetSpyOperation = function() return -1 end
    spy.IsReadyToMove = function() return nil end
    Cities.GetPlotPurchaseCity = function() reads=reads+1; return nil end
    assert(A.decisions({kind='espionage'}).total == 0 and reads == 0)
    assert(A.diagnostics.espionage.IsReadyToMove)
    local cities = Players[0]:GetCities()
    cities.GetNextCapturedCity = function() return cities:FindID(3) end
    CityDestroyDirectives = {KEEP=1}
    UnitOperationTypes.PARAM_FLAGS = 'flags'
    CityCommandTypes.DESTROY = 9002
    CityManager.CanStartCommand = function() error('native legality unavailable') end
    A.begin()
    assert(A.decisions({kind='city_fate'}).total == 0 and A.diagnostics.cityFate.CanStartCommand)
  `);
});

test("escape getter waits for the native escape blocker and stale choices never reach it", () => {
  scenario(`
    local A, reads = AstraCiv, 0
    local city = Players[0]:GetCities():FindID(3)
    Players[0]:GetDiplomacy().GetNextEscapingSpyID = function() reads=reads+1; return 7 end
    Cities.GetPlotPurchaseCity = function() return city end
    GameInfo.Districts.DISTRICT_CITY_CENTER = {Index=0, Name='Centre'}
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_PRODUCTION}
    local result = A.decisions({})
    assert(reads == 0, 'Default observation queried the native escaping-spy getter without an escape choice')
    local production = false
    for _, record in ipairs(result.decisions) do
      if record.kind == 'blocker' and record.blockerType == 'ENDTURN_BLOCKING_PRODUCTION' then production = true end
    end
    assert(production, 'Guard suppressed unrelated decisions')
    STUB_ACTIVE = false
    A.begin()
    A.decisions({kind='espionage'})
    assert(reads == 0 and A.diagnostics.espionage.escapeReadiness)
    STUB_ACTIVE = true
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    local record = A.decisions({kind='espionage', detail='full'}).decisions[1]
    assert(reads == 1 and record.operation == 'escape' and record.options[1].available)
    STUB_BLOCKERS = {}
    local answer = A.decide({id=record.id, choice='DISTRICT_CITY_CENTER'})
    assert(answer.status == 'stale' and not answer.accepted and reads == 1 and STUB_REQUEST_INDEX == 0)
    PlayerOperations.SET_ESCAPE_ROUTE, PlayerOperations.PARAM_DISTRICT_TYPE = 9003, 'district'
    local ok = pcall(A.decisionAction, {type='espionage', operation='escape', unitId=record.unitId, district='DISTRICT_CITY_CENTER'})
    assert(not ok and STUB_REQUEST_INDEX == 0, 'Direct escape action bypassed the pending-choice gate')
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_SPY_CHOOSE_ESCAPE_ROUTE}
    answer = A.decisionAction({type='espionage', operation='escape', unitId=record.unitId, district='DISTRICT_CITY_CENTER'})
    assert(answer.accepted and answer.submittedCount == 1 and STUB_REQUEST_INDEX == 1)
  `);
});

test("envoys are one native request per token and are refused before submission when illegal", () => {
  scenario(`
    local A = AstraCiv
    STUB_TOKENS_TO_GIVE, STUB_TOKENS_RECEIVED = 2, 1
    STUB_BLOCKERS = {EndTurnBlockingTypes.ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN}
    STUB_FIRST_BLOCKER = EndTurnBlockingTypes.ENDTURN_BLOCKING_GIVE_INFLUENCE_TOKEN
    local ballot = A.decisions({kind='envoy'})
    assert(ballot.total == 1 and ballot.decisions[1].id == 'test:decision:envoy:tokens:turn10')
    assert(ballot.decisions[1].tokensToGive == 2 and ballot.decisions[1].blocks == true)
    local record = A.decisions({kind='envoy', detail='full'}).decisions[1]
    assert(record.operations[1] == 'send' and record.operations[2] == 'consider')
    assert(record.options[1].choice == '2' and record.options[1].playerId == 2)
    assert(record.options[1].available and record.options[1].tokensReceived == 1)
    assert(record.options[1].label == 'LOC_TEST_CITY_STATE_NAME')
    -- Two tokens are two requests, each with PARAM_PLAYER_ONE; nothing is batched into one call.
    local sent = A.decisionAction({type='envoy', operation='send', target=2, count=2})
    assert(sent.accepted and sent.requestCount == 2 and sent.submittedCount == 2 and STUB_REQUEST_INDEX == 2)
    local requests = 0
    for _, entry in ipairs(STUB_TRACE()) do
      if entry.call == 'UI.RequestPlayerOperation' then
        requests = requests + 1
        assert(entry.data.operation == PlayerOperations.GIVE_INFLUENCE_TOKEN)
        assert(entry.data.parameters[PlayerOperations.PARAM_PLAYER_ONE] == 2)
      end
    end
    assert(requests == 2)
    assert(sent.observed.tokensToGive == 2 and sent.observed.tokensReceived == 1)
    -- More tokens than the engine says are available never reaches the engine.
    STUB_REQUEST_INDEX = 0
    local tooMany = pcall(A.decisionAction, {type='envoy', operation='send', target=2, count=3})
    assert(not tooMany and STUB_REQUEST_INDEX == 0, 'An impossible envoy count was submitted')
    -- The engine predicate, not our own belief about the city-state, decides legality.
    STUB_CAN_GIVE_TOKENS_TO = false
    local illegal = A.decisionAction({type='envoy', operation='send', target=2})
    assert(not illegal.accepted and illegal.status == 'illegal' and STUB_REQUEST_INDEX == 0)
    assert(illegal.canGiveTokensToPlayer == false)
    -- The reminder acknowledgement is a separate explicit operation and sends no token.
    STUB_CAN_GIVE_TOKENS_TO = true
    local considered = A.decisionAction({type='envoy', operation='consider'})
    assert(considered.accepted and considered.submittedCount == 1 and STUB_TOKENS_CONSIDERED == true)
    assert(considered.observed.considered == true and STUB_REQUEST_INDEX == 0)
  `);
});

test("the diplomacy family is delegated to its module at call time and reports a missing module honestly", () => {
  scenario(`
    local A = AstraCiv
    -- The real spec is published by lua/diplomacy.lua and copied by decisions.lua at load; this stub
    -- exists because the module is optional in this decisions-only harness.
    A.decisionActionTypes.diplomacy = {operations=A.array{'response'}, fields={}, native='stub module'}
    local collected, dispatched = 0, nil
    A.diplomacyDecisions = function(ctx, out)
      collected = collected + 1
      out[#out+1] = {key='42', kind='diplomacy', actionType='diplomacy', operation='response',
        operations=A.array{'response'}, label='Session 42', mandatory=true, sessionId=42,
        selectionSource='native_diplomacy_tables',
        options=A.array{{choice='CHOICE_POSITIVE', available=true}},
        choiceHelp='module-owned'}
      return out
    end
    A.diplomacyAction = function(ctx, args, record)
      dispatched = {args = args, record = record}
      return {accepted=true, completed=false, status='submitted', reasons=A.array(), requests=A.array(),
        requestCount=1, submittedCount=1, stoppedAt=A.null, note='module result'}
    end
    local record = A.decisions({kind='diplomacy', detail='full'}).decisions[1]
    assert(collected == 1 and record.id == 'test:decision:diplomacy:42' and record.sessionId == 42)
    local direct = A.decisionAction({type='diplomacy', operation='response', sessionId=42, key='CHOICE_POSITIVE'})
    assert(direct.accepted and dispatched.record == nil, 'civ.action must not pass a cached decision record')
    assert(dispatched.args.sessionId == 42 and dispatched.args.key == 'CHOICE_POSITIVE')
    local answered = A.decide({id=record.id, choice='CHOICE_POSITIVE', operation='response'})
    -- The re-collected record reaches the module, and the module's answer is stamped, not replaced.
    assert(answered.accepted and answered.id == record.id and answered.kind == 'diplomacy')
    assert(dispatched.record ~= nil and dispatched.record.id == record.id)
    assert(dispatched.record.selectionSource == 'native_diplomacy_tables')
    assert(dispatched.args.sessionId == 42 and dispatched.args.choice == 'CHOICE_POSITIVE')
    assert(answered.note == 'module result')
    -- Without the module the family degrades explicitly instead of vanishing or crashing.
    A.diplomacyDecisions, A.diplomacyAction = nil, nil
    A.begin()
    local missing = A.decisions({kind='diplomacy'})
    assert(missing.total == 0 and A.diagnostics.diplomacy.module)
    assert(A.diagnostics.decisions == nil)
    local refused = pcall(A.decisionAction, {type='diplomacy', operation='response', sessionId=42, key='CHOICE_POSITIVE'})
    assert(not refused and STUB_REQUEST_INDEX == 0)
  `);
});
