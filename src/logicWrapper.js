import {debounceTime, throttleTime, share, filter, mergeMap} from 'rxjs/operators';
import { merge, Observable } from 'rxjs';
import createLogicAction$ from './createLogicAction$';
import { confirmProps } from './utils';
// manual changes
// confirm custom Rx build imports
confirmProps(Observable, ['merge'], 'Observable');
confirmProps(Observable.prototype, [
  'debounceTime', 'filter', 'mergeMap', 'share', 'throttleTime'
], 'Observable.prototype');


export default function logicWrapper(logic, store, deps, monitor$) {
  const { type, cancelType, latest, debounce, throttle } = logic;

  // cancel on cancelType or if take latest specified
  const cancelTypes = []
    .concat((type && latest) ? type : [])
    .concat(cancelType || []);

  const debouncing = (debounce) ?
        act$ => act$.pipe(debounceTime(debounce)) :
        act$ => act$;

  const throttling = (throttle) ?
        act$ => act$.pipe(throttleTime(throttle)) :
        act$ => act$;

  const limiting = act =>
        throttling(debouncing(act));

  return function wrappedLogic(actionIn$) {
    // we want to share the same copy amongst all here
    const action$ = actionIn$.pipe(share());

    const cancel$ = (cancelTypes.length) ?
          action$.pipe(filter(action => matchesType(cancelTypes, action.type))) :
          Observable.create((/* obs */) => {}); // shouldn't complete

    // types that don't match will bypass this logic
    const nonMatchingAction$ = action$.pipe(filter(action => !matchesType(type, action.type)));

    const matchingAction$ =
      limiting(action$.pipe(filter(action => matchesType(type, action.type)))).pipe(mergeMap(action =>
          createLogicAction$({ action, logic, store, deps,
                               cancel$, monitor$ })));

    return merge(
      nonMatchingAction$,
      matchingAction$
    );
  };
}

function matchesType(tStrArrRe, type) {
  /* istanbul ignore if  */
  if (!tStrArrRe) { return false; } // nothing matches none
  if (typeof tStrArrRe === 'symbol') {
    return (tStrArrRe === type);
  }
  if (typeof tStrArrRe === 'string') {
    return (tStrArrRe === type || tStrArrRe === '*');
  }
  if (Array.isArray(tStrArrRe)) {
    return tStrArrRe.some(x => matchesType(x, type));
  }
  // else assume it is a RegExp
  return tStrArrRe.test(type);
}
