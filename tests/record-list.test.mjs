import assert from "node:assert/strict";
import test from "node:test";
import { ListingInputError, literalSearch, readRecordList, recordPage } from "../lib/record-list.ts";
const list=(query="",kind="requests")=>readRecordList(new URL(`http://localhost/list?${query}`),kind);

// Check hostile input and cursor reuse before either server sends SQL/upstream
// requests. Actual ordered records and permissions are covered over PostgreSQL.
test("list contract rejects unbounded, duplicate and unsupported filters",()=>{
  assert.equal(list().limit,100);
  for(const query of ["limit=0","limit=101","limit=-1","limit=1.5","limit=01","limit=1&limit=2",
    "status=unknown","status=Pending&status=Completed","type=data","url=https://example.test",
    `q=${"a".repeat(129)}`,"q=bad%00text","cursor=","cursor=%3Cscript%3E","cursor=e30"])
    assert.throws(()=>list(query),ListingInputError,query);
});
test("activity dates are real UTC instants and through is exclusive",()=>{
  const params=new URLSearchParams({from:"2026-10-01T05:00:00.000Z",through:"2026-10-02T05:00:00.000Z",type:"denied"});
  assert.equal(list(params,"activity").type,"denied");
  for(const query of ["type=unknown","status=Pending","from=2026-02-30T00:00:00.000Z",
    "from=invalid",`${params}&from=2026-10-01T05:00:00.000Z`,"from=2026-10-02T05:00:00.000Z&through=2026-10-01T05:00:00.000Z"])
    assert.throws(()=>list(query,"activity"),ListingInputError,query);
});
test("page cursor binds filters, page size and endpoint and handles tied timestamps",()=>{
  const base=list("limit=2&status=Pending&q=needle");
  const rows=[{id:"c",time:"2026-10-01T14:00:00Z"},{id:"b",time:"2026-10-01T14:00:00Z"},{id:"a",time:"2026-10-01T14:00:00Z"}];
  const result=recordPage(rows,base,row=>row.time);
  assert.deepEqual(result.records,rows.slice(0,2));
  assert.deepEqual(list(`limit=2&status=Pending&q=needle&cursor=${result.page.nextCursor}`).after,{time:rows[1].time,id:"b"});
  for(const query of ["limit=3&status=Pending&q=needle","limit=2&status=Completed&q=needle","limit=2&status=Pending&q=other"])
    assert.throws(()=>list(`${query}&cursor=${result.page.nextCursor}`),ListingInputError);
  assert.throws(()=>list(`limit=2&q=needle&cursor=${result.page.nextCursor}`,"activity"),ListingInputError);
  assert.equal(recordPage(rows.slice(0,2),base,row=>row.time).page.nextCursor,null);
  assert.equal(recordPage([],base,row=>row.time).page.nextCursor,null);
});
test("literal searches escape wildcard and escape characters without losing quotes",()=>{
  assert.equal(literalSearch("a%_\\'"),"%a\\%\\_\\\\'%");
});
