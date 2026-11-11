// Repeatable microbenchmark; it does not measure browser paint or network latency.
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {ranking, statistics} = require('../js/core');
const people = Array.from({length:10000}, (_,i) => ({
  id:String(i), name:`Участник ${10000-i}`, className:'9А', score:i%11===0?null:i%101
}));
function oldRanking(people) {
  let rank=0,previous;
  return people.filter(p=>p.score!==null).slice()
    .sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name,'ru')).map((p,i)=>{
      if(p.score!==previous)rank=i+1;previous=p.score;return {...p,rank};
    });
}
function oldStatistics(people) {
  const scores=people.filter(p=>p.score!==null).map(p=>p.score);
  const checked=people.filter(p=>p.score!==null);
  const bins=[0,0,0,0];checked.forEach(p=>bins[Math.min(3,Math.floor(p.score/100*4))]++);
  return {checked:checked.length,average:scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:0,
    best:scores.length?Math.max(...scores):0,bins};
}
assert.deepEqual(ranking(people),oldRanking(people));
assert.deepEqual(statistics(people,100),oldStatistics(people));
function median(fn) {
  for(let i=0;i<5;i++)fn();
  const times=[];
  for(let i=0;i<21;i++){const start=performance.now();fn();times.push(performance.now()-start);}
  return Number(times.sort((a,b)=>a-b)[10].toFixed(3));
}
const result={participants:people.length,unit:'milliseconds, median of 21 after 5 warmups',
  ranking:{before:median(()=>oldRanking(people)),after:median(()=>ranking(people))},
  statistics:{before:median(()=>oldStatistics(people)),after:median(()=>statistics(people,100))}};
console.log(JSON.stringify(result,null,2));
module.exports=result;
