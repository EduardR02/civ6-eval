// fengari and luaparse ship no type declarations. The Lua regression harness in
// test/lua.test.ts is the only consumer; it treats both as untyped JS.
declare module "fengari";
declare module "luaparse";
