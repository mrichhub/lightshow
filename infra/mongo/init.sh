#!/usr/bin/env bash
set -euo pipefail
mongosh --host mongo -u "$MONGO_ROOT_USER" -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --quiet --eval '
try { rs.status() } catch(e) { if(e.code === 94) rs.initiate({_id:"rs0",members:[{_id:0,host:"mongo:27017"}]}); else throw e; }
for(let n=0;n<60;n++){if(db.hello().isWritablePrimary) quit(0);sleep(1000)}quit(1);'
