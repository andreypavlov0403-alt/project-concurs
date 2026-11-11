/* Pure data operations shared by the interface and regression tests. */
(function (root) {
  'use strict';
  const nameOrder = new Intl.Collator('ru');
  function ranking(people) {
    let rank = 0, previous;
    return people.filter(p => p.score !== null).sort((a,b) => b.score-a.score || nameOrder.compare(a.name,b.name)).map((p,i) => {
      if (p.score !== previous) rank = i+1;
      previous = p.score;
      return {...p, rank};
    });
  }
  function statistics(people, maximum) {
    let checked=0, total=0, best=0;
    const bins=[0,0,0,0];
    for(const person of people) {
      if(person.score===null)continue;
      checked++;total+=person.score;best=Math.max(best,person.score);
      bins[Math.min(3,Math.floor(person.score/maximum*4))]++;
    }
    return {checked, average:checked?total/checked:0, best, bins};
  }
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, '');
    const leading=text.match(/^(?:[ \t]*\r?\n)+/)?.[0] || '';
    text = text.slice(leading.length);
    let quoted = false, counts = {',':0,';':0,'\t':0};
    // Detect the delimiter in the first logical record, including quoted newlines.
    for (let i=0;i<text.length;i++) {
      if (text[i] === '"') quoted = !quoted;
      else if (!quoted && (text[i] === '\r' || text[i] === '\n')) break;
      else if (!quoted && text[i] in counts) counts[text[i]]++;
    }
    const delimiter = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
    const rows=[]; let row=[],cell='', closed=false, line=1+(leading.match(/\n/g)||[]).length, recordLine=line; quoted=false;
    const pushCell=()=>{row.push(cell.trim());cell='';closed=false;};
    const pushRow=()=>{pushCell();if(row.some(Boolean))rows.push({cells:row,line:recordLine});row=[];};
    for (let i=0;i<text.length;i++) {
      const c=text[i];
      if(c==='"' && quoted && text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"'){
        if(closed || (!quoted && cell.trim()))throw Error(`Некорректная кавычка CSV, строка ${line}`);
        if(quoted){quoted=false;closed=true;}else quoted=true;
      }
      else if(c===delimiter && !quoted){pushCell();}
      else if((c==='\n'||c==='\r')&&!quoted){
        if(c==='\r'&&text[i+1]==='\n')i++;
        pushRow();line++;recordLine=line;
      }
      else {
        if(closed && c!==' ' && c!=='\t')throw Error(`Лишний символ после кавычки CSV, строка ${line}`);
        cell+=c;if(c==='\n' || (c==='\r' && text[i+1]!=='\n'))line++;
      }
    }
    if(quoted)throw Error('Незакрытая кавычка CSV');
    pushRow();
    if(!rows.length)throw Error('CSV пуст');
    const header=rows[0].cells.map(v=>v.toLowerCase().replace(/ё/g,'е'));
    const find=names=>header.findIndex(v=>names.includes(v));
    const n=find(['name','фио','участник']), g=find(['class','classname','класс','группа']), s=find(['score','баллы','балл']);
    const hasHeader=n>=0||g>=0||s>=0;
    if(hasHeader && (n<0||g<0||s<0))throw Error('Нужны столбцы ФИО, Класс и Баллы');
    const expected=hasHeader?header.length:3;
    return rows.slice(hasHeader?1:0).map(({cells:r,line})=>{
      if(r.length!==expected)throw Error(`CSV, строка ${line}: ожидается ${expected} столбцов, получено ${r.length}. Десятичную запятую заключите в кавычки или используйте разделитель «;».`);
      const name=r[hasHeader?n:0], className=r[hasHeader?g:1], raw=r[hasHeader?s:2];
      const score=raw===''||raw===undefined?null:Number(raw.replace(',','.'));
      if(!name||!className||(score!==null&&(!Number.isFinite(score)||score<0)))throw Error(`Некорректная запись CSV, строка ${line}`);
      return {name,className,score};
    });
  }
  function csvCell(value) {
    let text=String(value??'');
    if (/^[\s]*[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  }
  const api={ranking,statistics,parseCSV,csvCell};
  if(typeof module!=='undefined')module.exports=api;
  else root.SchoolFlow=api;
})(typeof window!=='undefined'?window:globalThis);
