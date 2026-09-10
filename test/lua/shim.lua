-- =====================================================================================
-- Lua 5.1 compatibility shim for the fengari (Lua 5.3) test VM.
--
-- EVERY line in this file marks a place where the harness is NOT Civ VI's runtime.
-- Civ VI's FireTuner interpreter is 5.1-flavoured; fengari is 5.3. Two classes of work:
--
--   (A) RESTORE 5.1-only library entries that fengari removed. Our trusted Lua may use
--       these legitimately, so without them the harness would report false failures.
--   (B) REMOVE 5.2/5.3-only library entries that Civ's 5.1 does not have. If our trusted
--       Lua reaches for one of these it is a REAL BUG that would throw in a live game,
--       and the harness must fail rather than paper over it.
--
-- Syntax-level 5.3-isms (goto/labels, integer division //, bitwise & | ~ << >>, \z string
-- escapes) cannot be removed at runtime. They are caught by the luaparse gate in
-- test/lua.test.ts, which parses every module with luaVersion "5.1".
--
-- KNOWN UNSHIMMED DIVERGENCES (documented, deliberately not patched):
--
--   1. `%z` in patterns. lua/common.lua's quote() uses '[%z\1-\31\\"]'. In 5.1 `%z` means
--      the NUL byte. In 5.2+ `%z` was removed and match_class falls through to "matches
--      the literal character", so under fengari that class matches the letter 'z' and
--      does NOT match NUL. Effect: the harness escapes every lowercase 'z' as z
--      (still valid JSON, still parses back to 'z') and would NOT escape a raw NUL byte.
--      This is correct-for-Civ code being misread by 5.3; it is not a bug in our code.
--      Consequence: the harness cannot prove NUL-byte escaping works.
--
--   2. Integer/float subtypes. 5.3 has an integer subtype; 5.1 does not. A.json formats
--      numbers with tostring(), so under fengari 3.0 serialises as "3.0" and 3 as "3",
--      whereas Civ's 5.1 renders both as "3". Both are valid JSON, but exact numeric
--      spelling in the emitted JSON is NOT evidence about the live game.
--
--   3. String-to-number coercion and tostring() formatting of large/small floats differ
--      slightly in the last digits between 5.1 (%.14g) and 5.3 (%.14g on floats, exact on
--      integers). Round-trip validity is proven; byte-identity with the game is not.
-- =====================================================================================

-- (A) RESTORE: 5.1 globals fengari does not provide.
--   `unpack` — required. lua/common.lua's A.call/A.static call bare unpack(args).
unpack = table.unpack
--   `math.log10` / `math.pow` / `table.maxn` — present in Civ's 5.1, removed in 5.3.
--   Restored so a legitimate use does not read as a harness failure.
math.log10 = math.log10 or function(x) return math.log(x, 10) end
math.pow = math.pow or function(x, y) return x ^ y end
table.maxn = table.maxn or function(t)
  local n = 0
  for k in pairs(t) do if type(k) == 'number' and k > n then n = k end end
  return n
end

-- (B) REMOVE: 5.2/5.3-only entries Civ's 5.1 interpreter does not have.
--   Reaching for any of these from lua/** is a real bug; the harness must surface it.
table.unpack = nil
table.pack = nil
table.move = nil
math.type = nil
math.tointeger = nil
math.maxinteger = nil
math.mininteger = nil
math.ult = nil
string.pack = nil
string.unpack = nil
string.packsize = nil
rawlen = nil

-- REMOVE: host facilities the FireTuner sandbox does not expose to these modules, and
-- which trusted game-interface Lua must never use. (Not strictly a 5.1/5.3 issue; this is
-- a sandbox-fidelity guard so the harness cannot pass by reading the real filesystem.)
io = nil
os = nil
package = nil
require = nil
dofile = nil
loadfile = nil
load = nil
loadstring = nil
collectgarbage = nil

-- Print capture. lua/common.lua's A.emit() ships its payload through print(); the harness
-- reassembles those lines exactly the way src/bridge.ts collect() does.
STUB_PRINT = {}
function print(...)
  local count = select('#', ...)
  local parts = {}
  for i = 1, count do parts[i] = tostring((select(i, ...))) end
  STUB_PRINT[#STUB_PRINT + 1] = table.concat(parts, '\t')
end

function STUB_DRAIN()
  local text = table.concat(STUB_PRINT, '\n')
  STUB_PRINT = {}
  return text
end
