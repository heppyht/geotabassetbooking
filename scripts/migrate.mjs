/*───────────────────── Migration script (AddInData) ─────────────────────*/
/* No SQL migrations needed. MyGeotab AddInData is schema-less; records are
   self-describing via their `recordType` and `schemaVersion` fields.
   Backward compatibility is handled in code (see addinDataService normalize
   functions). This script is retained as a no-op placeholder.
*/

console.log("No SQL migrations required. Persistent data lives in MyGeotab AddInData.");
console.log("Schema evolution is handled in code via recordType/schemaVersion fields.");
