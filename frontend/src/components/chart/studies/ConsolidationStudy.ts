import type { CleanBar } from "../ChartTypes";

export interface ConsolidationRange {
  startIndex: number;
  confirmationIndex: number;
  endIndex: number;
  high: number;
  low: number;
  score: number;
  breakout?: "up" | "down";
}

export function detectConsolidationRanges(bars: CleanBar[]): ConsolidationRange[] {
  const windows = [20, 12, 8], baseline = 20, eps = 1e-9;
  const ranges: ConsolidationRange[] = [];
  let active: ConsolidationRange | undefined;
  let nextStart = 0;
  const tr = (i: number) => Math.max(bars[i].high-bars[i].low, i ? Math.abs(bars[i].high-bars[i-1].close) : 0, i ? Math.abs(bars[i].low-bars[i-1].close) : 0);
  for (let t = 0; t < bars.length - 1; t++) {
    if (active) {
      active.endIndex = t;
      if (bars[t].close > active.high + eps || bars[t].close < active.low - eps) {
        active.breakout = bars[t].close > active.high + eps ? "up" : "down";
        active = undefined;
        nextStart = t + 1;
      }
      continue;
    }
    for (const window of windows) {
    const start = t - window + 1;
    if (start < Math.max(8,nextStart)) continue;
    let high = -Infinity, low = Infinity, path = 0, recent = 0, overlaps = 0, prior = 0;
    const baseStart = Math.max(0,start-baseline);
    for (let j = baseStart; j < start; j++) prior += tr(j);
    prior /= start-baseStart;
    for (let j = start; j <= t; j++) {
      const b = bars[j];
      high = Math.max(high,b.open,b.close);
      low = Math.min(low,b.open,b.close);
      recent += tr(j);
      if (j === start) continue;
      const p = bars[j-1];
      path += Math.abs(b.close-p.close);
      const intersection = Math.min(b.high,p.high)-Math.max(b.low,p.low);
      const smaller = Math.min(b.high-b.low,p.high-p.low);
      if (smaller > eps && intersection >= 0.25*smaller) overlaps++;
    }
    recent /= window;
    if (prior <= eps || high-low <= eps) continue;
    const efficiency = path > eps ? Math.abs(bars[t].close-bars[start].close)/path : 0;
    const overlap = overlaps/(window-1);
    const narrow = high-low <= 4.5*prior;
    const slow = efficiency <= 0.30;
    const score = (slow?35:0)+(overlap>=0.60?25:0)+(recent<=0.85*prior?25:0)+(narrow?15:0);
    const span = high-low;
    const centers: number[] = [];
    let upperGroups = 0, lowerGroups = 0, maxBody = 0;
    for (let group = 0; group < 3; group++) {
      const from = start+Math.floor(group*window/3);
      const to = start+Math.floor((group+1)*window/3);
      let sum = 0, upper = false, lower = false;
      for (let j = from; j < to; j++) {
        const bar = bars[j];
        sum += bar.close;
        maxBody = Math.max(maxBody,Math.abs(bar.close-bar.open));
        if (Math.max(bar.open,bar.close) >= high-0.25*span) upper = true;
        if (Math.min(bar.open,bar.close) <= low+0.25*span) lower = true;
      }
      centers.push(sum/(to-from));
      if (upper) upperGroups++;
      if (lower) lowerGroups++;
    }
    const stable = Math.max(...centers)-Math.min(...centers) <= 0.35*span;
    const repeated = upperGroups >= 2 && lowerGroups >= 2;
    const noImpulse = maxBody <= 0.55*span;
    const mid = (high+low)/2;
    let smallMoves = 0;
    for (let j = start+1; j <= t; j++) {
      if (Math.abs(bars[j].close-bars[j-1].close) <= 0.25*span) smallMoves++;
    }
    const quiet = smallMoves/(window-1) >= 0.60;
    const tight = mid > eps && span/mid <= 0.075 && span <= 6*prior;
    const rangeQualified = slow && narrow && overlap >= 0.60 && stable && repeated && noImpulse && score >= 75;
    const compressionQualified = efficiency <= 0.30 && stable && tight && quiet && maxBody <= 0.65*span;
    if (!rangeQualified && !compressionQualified) continue;
    const finalScore = rangeQualified ? score : Math.max(75,score);
    active = {startIndex:start,confirmationIndex:t,endIndex:t,high,low,score:finalScore};
    ranges.push(active);
    break;
    }
  }
  return ranges;
}

export interface StructuralPattern extends ConsolidationRange {
  kind: string;
  upperStart: number;
  lowerStart: number;
  upperSlope: number;
  lowerSlope: number;
  tolerance: number;
  sweeps: {index:number;side:'up'|'down'}[];
}

export function patternBoundaryAt(p: StructuralPattern,i:number) {
  return {
    high:p.upperStart+p.upperSlope*(i-p.startIndex),
    low:p.lowerStart+p.lowerSlope*(i-p.startIndex)
  };
}

export function detectStructuralPatterns(
  bars:CleanBar[],
  source:'body'|'wick'|'hybrid'='hybrid'
):StructuralPattern[] {
  const result:StructuralPattern[]=[];
  const hi=bars.map(b=>source==='wick'?b.high:Math.max(b.open,b.close));
  const lo=bars.map(b=>source==='wick'?b.low:Math.min(b.open,b.close));
  const eps=1e-9;
  let active:StructuralPattern|undefined;
  let nextStart=0, outside=0, direction=0;

  for(let t=0;t<bars.length-1;t++) {
    if(active) {
      const edge=patternBoundaryAt(active,t);

      // Prevent expanding formations from growing indefinitely.
      if(active.kind==='EXPANDING RANGE') {
        const confirmed=patternBoundaryAt(
          active,active.confirmationIndex
        );

        const confirmedWidth=confirmed.high-confirmed.low;
        const currentWidth=edge.high-edge.low;

        const formationLength=
          active.confirmationIndex-active.startIndex+1;

        let stale=false;

        if(t-active.confirmationIndex>=formationLength) {
          let upperTouch=false;
          let lowerTouch=false;

          const from=Math.max(
            active.confirmationIndex,
            t-formationLength+1
          );

          for(let j=from;j<=t;j++) {
            const boundary=patternBoundaryAt(active,j);

            if(Math.abs(hi[j]-boundary.high)<=active.tolerance*2)
              upperTouch=true;

            if(Math.abs(lo[j]-boundary.low)<=active.tolerance*2)
              lowerTouch=true;
          }

          stale=!upperTouch || !lowerTouch;
        }

        const close=bars[t].close;
        const inside=
          close<=edge.high+active.tolerance/2 &&
          close>=edge.low-active.tolerance/2;

        if(inside && (
          currentWidth>confirmedWidth*1.5 || stale
        )) {
          active=undefined;
          nextStart=t;
          outside=0;
          direction=0;
          continue;
        }
      }

      if(edge.high-edge.low<=active.tolerance) {
        active=undefined;
        nextStart=t;
        outside=0;
        continue;
      }

      active.endIndex=t;
      active.high=Math.max(active.high,edge.high);
      active.low=Math.min(active.low,edge.low);

      const close=bars[t].close;

      if(source==='hybrid') {
        if(bars[t].high>edge.high+active.tolerance && close<=edge.high)
          active.sweeps.push({index:t,side:'up'});

        if(bars[t].low<edge.low-active.tolerance && close>=edge.low)
          active.sweeps.push({index:t,side:'down'});
      }

      const d=close>edge.high+active.tolerance/2?1:
        close<edge.low-active.tolerance/2?-1:0;

      outside=d===0?0:d===direction?outside+1:1;
      direction=d;

      if(d!==0 && (
        outside>=2 ||
        (d===1?close-edge.high:edge.low-close)>=2*active.tolerance
      )) {
        active.breakout=d===1?'up':'down';
        active=undefined;
        nextStart=t+1;
        outside=0;
      }

      continue;
    }

    const tr=bars.slice(Math.max(0,t-19),t+1)
      .map(b=>b.high-b.low).sort((a,b)=>a-b);

    const typical=tr[Math.floor(tr.length/2)]||0;
    if(typical<=eps) continue;

    const tol=Math.max(typical*.30,Math.abs(bars[t].close)*.001);

    for(const n of [48,32,20,12]) {
      const start=t-n+1;
      if(start<nextStart || start<0) continue;

      const highs:number[]=[],lows:number[]=[];

      for(let j=start+1;j<t;j++) {
        if(hi[j]>=hi[j-1] && hi[j]>hi[j+1]) highs.push(j);
        if(lo[j]<=lo[j-1] && lo[j]<lo[j+1]) lows.push(j);
      }

      const fit=(ids:number[],values:number[],upper:boolean)=>{
        let best:{
          base:number;
          slope:number;
          touches:number[];
          score:number
        }|undefined;

        const candidates=ids.slice(-6);

        for(let a=0;a<candidates.length;a++)
        for(let b=a+1;b<candidates.length;b++) {
          const x=candidates[a],z=candidates[b];

          if(z-x<Math.max(2,n*.25)) continue;

          const slope=(values[z]-values[x])/(z-x);
          const base=values[x]-slope*(x-start);

          const touches=ids.filter(i=>
            Math.abs(values[i]-base-slope*(i-start))<=tol
          );

          let violations=0;

          for(let j=start;j<=t;j++)
            if((upper?1:-1)*(values[j]-base-slope*(j-start))>tol)
              violations++;

          if(violations>n*.15) continue;

          const score=touches.length*3-violations*2+(z-x)/n;

          if(!best||score>best.score)
            best={base,slope,touches,score};
        }

        return best;
      };

      const u=fit(highs,hi,true);
      const l=fit(lows,lo,false);

      if(!u||!l) continue;

      const w0=u.base-l.base;
      const w1=w0+(u.slope-l.slope)*(n-1);

      if(Math.min(w0,w1)<Math.max(tol*2,typical*.65) ||
         Math.max(w0,w1)>typical*12) continue;

      const touches=[
        ...u.touches.map(i=>({i,side:1})),
        ...l.touches.map(i=>({i,side:-1}))
      ].sort((a,b)=>a.i-b.i);

      let turns=0;

      for(let j=1;j<touches.length;j++)
        if(touches[j].i!==touches[j-1].i &&
           touches[j].side!==touches[j-1].side)
          turns++;

      if(turns<3) continue;

      let inside=0;

      for(let j=start;j<=t;j++)
        if(bars[j].close<=u.base+u.slope*(j-start)+tol &&
           bars[j].close>=l.base+l.slope*(j-start)-tol)
          inside++;

      if(inside/n<.85 ||
         bars[t].close>u.base+u.slope*(n-1) ||
         bars[t].close<l.base+l.slope*(n-1)) continue;

      const du=u.slope*(n-1);
      const dl=l.slope*(n-1);
      const flat=Math.max(tol,w0*.08);

      const us=Math.abs(du)<=flat?0:Math.sign(du);
      const ls=Math.abs(dl)<=flat?0:Math.sign(dl);

      const converges=w1<w0*.8;
      const expands=w1>w0*1.2;

      let kind='';

      if(us===0&&ls===0)
        kind='CONSOLIDATION';
      else if(converges&&us===0&&ls===1)
        kind='ASCENDING TRIANGLE';
      else if(converges&&us===-1&&ls===0)
        kind='DESCENDING TRIANGLE';
      else if(converges&&us===-1&&ls===1)
        kind='SYMMETRICAL TRIANGLE';
      else if(converges&&us===ls&&us!==0)
        kind=us===1?'RISING WEDGE':'FALLING WEDGE';
      else if(expands&&us===1&&ls===-1)
        kind='EXPANDING RANGE';
      else if(!converges&&!expands&&us===ls&&us!==0) {
        const impulse=bars[start].close-
          bars[Math.max(0,start-Math.min(12,n))].close;

        kind=us===-1&&impulse>=3*typical?'POTENTIAL BULL FLAG':
          us===1&&impulse<=-3*typical?'POTENTIAL BEAR FLAG':
          us===1?'ASCENDING CHANNEL':'DESCENDING CHANNEL';
      }

      if(!kind) continue;

      // Meaningful pattern qualification.
      // Reject ordinary price movement and weak formations.
      if(
        kind==='ASCENDING CHANNEL' ||
        kind==='DESCENDING CHANNEL' ||
        kind==='EXPANDING RANGE'
      ) continue;

      const uniqueTouches=new Set(
        touches.map(touch=>touch.i)
      ).size;

      const strongCompression=
        converges && w1<=w0*.65;

      const reliableTouches=
        uniqueTouches>=5 && turns>=4;

      if(u.touches.length<2 || l.touches.length<2)
        continue;

      if(!reliableTouches && !(
        strongCompression &&
        uniqueTouches>=4 &&
        turns>=3
      )) continue;

      if(kind==='CONSOLIDATION') {
        const displacement=Math.abs(
          bars[t].close-bars[start].close
        );

        if(displacement>Math.max(w0,w1)*.65)
          continue;
      }

      if(kind.includes('FLAG')) {
        const impulseStart=
          Math.max(0,start-Math.min(12,n));

        const impulse=Math.abs(
          bars[start].close-bars[impulseStart].close
        );

        if(impulse<Math.max(
          typical*3,
          Math.max(w0,w1)*1.25
        )) continue;
      }

      active={
        kind,
        startIndex:start,
        confirmationIndex:t,
        endIndex:t,
        upperStart:u.base,
        lowerStart:l.base,
        upperSlope:u.slope,
        lowerSlope:l.slope,
        high:Math.max(u.base,u.base+du),
        low:Math.min(l.base,l.base+dl),
        tolerance:tol,
        score:Math.min(100,Math.round(
          inside/n*70+Math.min(30,touches.length*5)
        )),
        sweeps:[]
      };

      result.push(active);
      outside=0;
      direction=0;
      break;
    }
  }

  return result;
}
