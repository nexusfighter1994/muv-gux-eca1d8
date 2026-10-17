const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s.replaceAll('\r\n','\n')).digest('hex');
function patch(source){
 const contract=JSON.parse(fs.readFileSync(path.join(__dirname,'contract.json'),'utf8'));
 const before=fs.readFileSync(path.join(__dirname,'original.js.txt'),'utf8'),after=fs.readFileSync(path.join(__dirname,'optimized.js.txt'),'utf8');
 if(hash(before)!==contract.original||hash(after)!==contract.optimized)throw Error('ETA helper drift');
 if(source.includes(after)){if(source.split(after).length!==2||source.includes(before))throw Error('Ambiguous ETA patch');return source;}
 if(source.split(before).length!==2)throw Error('Native ETA function changed');
 return source.replace(before,after);
}
module.exports={patch};
if(require.main===module){
 const index=process.argv[2];if(!index)throw Error('Explicit native index required');
 const source=fs.readFileSync(index,'utf8'),output=patch(source);
 if(output!==source)fs.writeFileSync(index,output);
 console.log(JSON.stringify({etaDisplay:true,before:hash(source),after:hash(output),schedulerChanged:false}));
}
