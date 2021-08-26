import { map, catchError } from 'rxjs/operators';
import { of } from 'rxjs';
import { createLogic } from 'redux-logic';
import { usersFetch, usersFetchCancel, usersFetchFulfilled,
         usersFetchRejected } from './actions';

const delay = 4; // 4s delay for interactive use of cancel/take latest

export const usersFetchLogic = createLogic({
  type: usersFetch,
  cancelType: usersFetchCancel,
  latest: true, // take latest only

  process({ httpClient }, dispatch, done) {
    // dispatch the results of the observable
    dispatch(
      httpClient.getJSON(`https://reqres.in/api/users?delay=${delay}`).pipe(map(payload => payload.data), map(users => usersFetchFulfilled(users)), catchError(err => of(usersFetchRejected(err))))
    );
    done(); // call when done dispatching
  }
});


export default [
  usersFetchLogic
];
