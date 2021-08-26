import { ajax } from 'rxjs';
import { map } from 'rxjs/operators';
import { createLogic } from 'redux-logic';
import { SEARCH, searchFulfilled, searchRejected } from './actions';

export const searchLogic = createLogic({
  type: SEARCH,
  debounce: 500, /* ms */
  latest: true,  /* take latest only */
  /* and since we are using rxjs ajax which returns an observable
     the XRH requests are automatically aborted when redux-logic
     cancels the observable */

  validate({ action }, allow, reject) {
    if (!action.payload) { reject(); }
    allow(action);
  },

  processOptions: {
    successType: searchFulfilled, // action creator to wrap success result
    failType: searchRejected      // action creator to wrap failed result
  },

  process({ getState, action }) {
    return ajax(Object.assign({}, {
      url: `https://npmsearch.com/query?q=${action.payload}&fields=name,description`,
      crossDomain: true,
      responseType: 'json'
    }, {crossDomain: true}).pipe(map(ret => ret.response.results)); // use results prop of payload
  }
});

export default [
  searchLogic
];
