const {test}=require('node:test'),assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');const {writeBatch}=require('./rag_vector_cache.cjs');
function database(){const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE vectors(key TEXT PRIMARY KEY,vector TEXT NOT NULL,truncated INTEGER NOT NULL)');return db;}
test('batch preserves exact rows and INSERT OR IGNORE ownership in one explicit transaction',()=>{
 const db=database(),insert=db.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?,?)');
 insert.run('existing','old',0);const rows=[['a','[0.25,0.75]',0],['b','[0.5,0.5]',1],['existing','new',1],['a','duplicate',1]];
 const statements=[];writeBatch({exec:s=>{statements.push(s);db.exec(s);}},insert,rows);
 assert.deepEqual(statements,['BEGIN','COMMIT']);assert.deepEqual(db.prepare('SELECT * FROM vectors ORDER BY key').all().map(r=>({...r})),[{key:'a',vector:'[0.25,0.75]',truncated:0},{key:'b',vector:'[0.5,0.5]',truncated:1},{key:'existing',vector:'old',truncated:0}]);db.close();
});
test('a failed later insert leaves zero partial rows and preserves prior observations',()=>{
 const db=database(),insert=db.prepare('INSERT OR IGNORE INTO vectors VALUES(?,?,?)');insert.run('prior','keep',0);let count=0;
 assert.throws(()=>writeBatch(db,{run:(...row)=>{if(++count===2)throw new Error('injected cache failure');insert.run(...row);}},[['a','first',0],['b','second',0]]),/injected cache failure/);
 assert.deepEqual(db.prepare('SELECT * FROM vectors').all().map(r=>({...r})),[{key:'prior',vector:'keep',truncated:0}]);db.close();
});
