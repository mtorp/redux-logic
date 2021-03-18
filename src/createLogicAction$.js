import {take, defaultIfEmpty, takeUntil, tap, mergeAll} from 'rxjs/operators';
import { timer, from, throwError, of, Observable, Subject } from 'rxjs';
import isPromise from 'is-promise';
import { confirmProps, isObservable } from './utils';

// confirm custom Rx build imports
confirmProps(Observable, ['fromPromise', 'of', 'throw', 'timer'],
             'Observable');
confirmProps(Observable.prototype, ['defaultIfEmpty', 'do', 'filter',
  'map', 'mergeAll', 'take', 'takeUntil'], 'Observable.prototype');

const UNHANDLED_LOGIC_ERROR = 'UNHANDLED_LOGIC_ERROR';
const NODE_ENV = process.env.NODE_ENV;

const debug = (/* ...args */) => {};

export default function createLogicAction$({ action, logic, store, deps, cancel$, monitor$ }) {
  const { getState } = store;
  const { name, warnTimeout, process: processFn,
          processOptions: { dispatchReturn, dispatchMultiple,
                            successType, failType } } = logic;
  const intercept = logic.validate || logic.transform; // aliases

  debug('createLogicAction$', name, action);
  monitor$.next({ action, name, op: 'begin' });

  // once action reaches bottom, filtered, nextDisp, or cancelled
  let interceptComplete = false;

  // logicAction$ is used for the mw next(action) call
  const logicAction$ = Observable.create(logicActionObs => {
    // create notification subject for process which we dispose of
    // when take(1) or when we are done dispatching
    const cancelled$ = (new Subject()).pipe(take(1));
    cancel$.subscribe(cancelled$); // connect cancelled$ to cancel$
    cancelled$
      .subscribe(
        () => {
          if (!interceptComplete) {
            monitor$.next({ action, name, op: 'cancelled' });
          } else { // marking these different so not counted twice
            monitor$.next({ action, name, op: 'dispCancelled' });
          }
        }
      );

    // In non-production mode only we will setup a warning timeout that
    // will console.error if logic has not completed by the time it fires
    // warnTimeout can be set to 0 to disable
    if (NODE_ENV !== 'production' && warnTimeout) {
      timer(warnTimeout).pipe(takeUntil(cancelled$.pipe(defaultIfEmpty(true))), tap(() => {
          // eslint-disable-next-line no-console
          console.error(`warning: logic (${name}) is still running after ${warnTimeout / 1000}s, forget to call done()? For non-ending logic, set warnTimeout: 0`);
        }))
        .subscribe();
    }

    const dispatch$ = (new Subject()).pipe(mergeAll(), takeUntil(cancel$));
    dispatch$.pipe(tap(// next
    mapToActionAndDispatch, // error
    mapErrorToActionAndDispatch))
      .subscribe({
        error: (/* err */) => {
          monitor$.next({ action, name, op: 'end' });
          // signalling complete here since error was dispatched
          // accordingly, otherwise if we were to signal an error here
          // then cancelled$ subscriptions would have to specifically
          // handle error in subscribe otherwise it will throw. So
          // it doesn't seem that it is worth it.
          cancelled$.complete();
          cancelled$.unsubscribe();
        },
        complete: () => {
          monitor$.next({ action, name, op: 'end' });
          cancelled$.complete();
          cancelled$.unsubscribe();
        }
      });

    function storeDispatch(act) {
      monitor$.next({ action, dispAction: act, op: 'dispatch' });
      return store.dispatch(act);
    }

    function mapToActionAndDispatch(actionOrValue) {
      const act =
        (isInterceptAction(actionOrValue)) ? unwrapInterceptAction(actionOrValue) :
        (successType) ? mapToAction(successType, actionOrValue, false) :
        actionOrValue;
      if (act) {
        storeDispatch(act);
      }
    }

    /* eslint-disable consistent-return */
    function mapErrorToActionAndDispatch(actionOrValue) {
      // action dispatched from intercept needs to be unwrapped and sent as is
      if (isInterceptAction(actionOrValue)) {
        const interceptAction = unwrapInterceptAction(actionOrValue);
        return storeDispatch(interceptAction);
      }

      if (failType) {
        // we have a failType, if truthy result we will use it
        const act = mapToAction(failType, actionOrValue, true);
        if (act) {
          return storeDispatch(act);
        }
        return; // falsey result from failType, no dispatch
      }

      // no failType so must wrap values with no type
      if (actionOrValue instanceof Error) {
        const act =
          (actionOrValue.type) ? actionOrValue : // has type
          {
            type: UNHANDLED_LOGIC_ERROR,
            payload: actionOrValue,
            error: true
          };
        return storeDispatch(act);
      }

      // dispatch objects or functions as is
      const typeOfValue = typeof actionOrValue;
      if (actionOrValue && ( // not null and is object | fn
          typeOfValue === 'object' || typeOfValue === 'function')) {
        return storeDispatch(actionOrValue);
      }

      // wasn't an error, obj, or fn, so we will wrap in unhandled
      storeDispatch({
        type: UNHANDLED_LOGIC_ERROR,
        payload: actionOrValue,
        error: true
      });
    }
    /* eslint-enable consistent-return */

    function mapToAction(type, payload, err) {
      if (typeof type === 'function') { // action creator fn
        return type(payload);
      }
      const act = { type, payload };
      if (err) { act.error = true; }
      return act;
    }

    // allowMore is now deprecated in favor of variable process arity
    // which sets processOptions.dispatchMultiple = true then
    // expects done() cb to be called to end
    // Might still be needed for internal use so keeping it for now
    const DispatchDefaults = {
      allowMore: false
    };

    function dispatch(act, options = DispatchDefaults) {
      const { allowMore } = applyDispatchDefaults(options);
      if (typeof act !== 'undefined') { // ignore empty action
        dispatch$.next( // create obs for mergeAll
          // eslint-disable-next-line no-nested-ternary
          (isObservable(act)) ? act :
          (isPromise(act)) ? from(act) :
          (act instanceof Error) ? throwError(act) :
          of(act)
        );
      }
      if (!(dispatchMultiple || allowMore)) { dispatch$.complete(); }
      return act;
    }

    function applyDispatchDefaults(options) {
      return {
        ...DispatchDefaults,
        ...options
      };
    }

    // passed into each execution phase hook as first argument
    const depObj = {
      ...deps,
      cancelled$,
      ctx: {}, // for sharing data between hooks
      getState,
      action
    };

    function shouldDispatch(act, useDispatch) {
      if (!act) { return false; }
      if (useDispatch === 'auto') { // dispatch on diff type
        return (act.type !== action.type);
      }
      return (useDispatch); // otherwise forced truthy/falsy
    }

    const AllowRejectNextDefaults = {
      useDispatch: 'auto'
    };

    function applyAllowRejectNextDefaults(options) {
      return {
        ...AllowRejectNextDefaults,
        ...options
      };
    }

    function allow(act, options = AllowRejectNextDefaults) {
      handleNextOrDispatch(true, act, options);
    }

    function reject(act, options = AllowRejectNextDefaults) {
      handleNextOrDispatch(false, act, options);
    }

    function done() {
      dispatch$.complete();
    }

    // we want to know that this was from intercept (validate/transform)
    // so that we don't apply any processOptions wrapping to it
    function wrapActionForIntercept(act) {
      if (!act) { return act; }
      return {
        __interceptAction: act
      };
    }

    function isInterceptAction(act) {
      // eslint-disable-next-line no-underscore-dangle
      return act && act.__interceptAction;
    }

    function unwrapInterceptAction(act) {
      // eslint-disable-next-line no-underscore-dangle
      return act.__interceptAction;
    }

    function handleNextOrDispatch(shouldProcess, act, options) {
      const { useDispatch } = applyAllowRejectNextDefaults(options);
      if (shouldDispatch(act, useDispatch)) {
        monitor$.next({ action, dispAction: act, name, shouldProcess, op: 'nextDisp' });
        interceptComplete = true;
        dispatch(wrapActionForIntercept(act), { allowMore: true }); // will be completed later
        logicActionObs.complete(); // dispatched action, so no next(act)
      } else { // normal next
        if (act) {
          monitor$.next({ action, nextAction: act, name, shouldProcess, op: 'next' });
        } else { // act is undefined, filtered
          monitor$.next({ action, name, shouldProcess, op: 'filtered' });
          interceptComplete = true;
        }
        postIfDefinedOrComplete(act, logicActionObs);
      }

      // unless rejected, we will process even if allow/next dispatched
      if (shouldProcess) { // processing, was an accept
        // if action provided is empty, give process orig
        depObj.action = act || action;
        try {
          const retValue = processFn(depObj, dispatch, done);
          if (dispatchReturn) { // processOption.dispatchReturn true
            // returning undefined won't dispatch
            if (typeof retValue === 'undefined') {
              dispatch$.complete();
            } else { // defined return value, dispatch
              dispatch(retValue);
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`unhandled exception in logic named: ${name}`, err);
          // wrap in observable since might not be an error object
          dispatch(throwError(err));
        }
      } else { // not processing, must have been a reject
        dispatch$.complete();
      }
    }

    /* post if defined, then complete */
    function postIfDefinedOrComplete(act, act$) {
      if (act) {
        act$.next(act);  // triggers call to middleware's next()
      }
      interceptComplete = true;
      act$.complete();
    }

    // start use of the action
    function start() {
      intercept(depObj, allow, reject);
    }

    start();
  }).pipe(takeUntil(cancel$), take(1));

  return logicAction$;
}
