import assert from "node:assert/strict";
import test from "node:test";
import { leastPrivilegeSql, countDbtResources } from "../src/lib/organizations.js";
import { hasPermission } from "../src/lib/permissions.js";

test("setup SQL normalizes identifiers and grants narrow metadata roles", () => {
  const sql = leastPrivilegeSql({roleName:" reader ",warehouseName:" compute_wh ",userName:" svc "});
  assert.match(sql, /CREATE ROLE IF NOT EXISTS "READER"/);
  assert.match(sql, /SNOWFLAKE.USAGE_VIEWER/);
  assert.doesNotMatch(sql, /imported privileges|RSA_PUBLIC_KEY/i);
});
test("setup preview does not emit user-supplied SQL or privileged roles", () => {
  for (const roleName of ["ACCOUNTADMIN", "READER; DROP USER SVC", "bad role"]) {
    assert.equal(leastPrivilegeSql({roleName,warehouseName:"WH",userName:"SVC"}).startsWith("-- Enter"), true);
  }
});
test("only owners can promote owners; operators cannot manage connection or members", () => {
  assert.equal(hasPermission("owner", "transfer_ownership"), true);
  for (const role of ["admin","operator","viewer",undefined]) assert.equal(hasPermission(role,"transfer_ownership"),false);
  for (const capability of ["manage_members","manage_connection"]) assert.equal(hasPermission("operator",capability),false);
  assert.equal(hasPermission("operator","trigger_sync"),true);
});
test("manifest preview counts supported resources, including sources", () => {
  assert.equal(countDbtResources({nodes:{model:{resource_type:"model",name:"orders"},test:{resource_type:"test",name:"test"}},sources:{source:{resource_type:"source",name:"orders"}}}),2);
  assert.equal(countDbtResources(null),0);
});
