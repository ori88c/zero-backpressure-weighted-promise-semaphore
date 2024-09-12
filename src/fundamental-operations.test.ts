/**
 * Copyright 2024 Ori Cohen https://github.com/ori88c
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  ZeroBackpressureWeightedSemaphore,
  SemaphoreJob
} from './zero-backpressure-weighted-promise-semaphore';

type PromiseResolveCallbackType = (value?: unknown) => void;

interface CustomJobError extends Error {
  jobID: number;
}

/**
 * resolveFast
 * 
 * The one-and-only purpose of this function, is triggerring an event-loop iteration.
 * It is relevant whenever a test needs to simulate tasks from the Node.js' micro-tasks queue.
 */
const resolveFast = async () => {
  expect(14).toBeGreaterThan(3);
};

// This test suite focuses on fundamental semaphore functionality without
// considering weighted scenarios. Therefore, all jobs have equal weight.
describe('ZeroBackpressureWeightedSemaphore fundamental operations tests', () => {
  describe('Happy path tests', () => {
    test(
      'waitForCompletion: should process only one job at a time, ' +
      'when jobs happen to be scheduled sequentially (trivial case)', async () => {
      const jobWeight = 1; // Each job will have a 1 unit of weight.
      const totalAllowedWeight = 7;
      const maxConcurrentJobs = totalAllowedWeight;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        maxConcurrentJobs
      );
      let completeCurrentJob: PromiseResolveCallbackType;
      const numberOfJobs = 10;
        
      for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
        expect(semaphore.availableWeight).toBe(totalAllowedWeight);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
        expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
        expect(semaphore.amountOfUncaughtErrors).toBe(0);

        const jobPromise = new Promise<void>(res => completeCurrentJob = res);
        const job = () => jobPromise;
        const waitTillCompletionPromise: Promise<void> = semaphore.waitForCompletion(job, jobWeight);
          
        // Trigger the event loop to allow the semaphore to allocate a slot for the current job.
        // The waitTillCompletionPromise will not be resolved yet.
        await Promise.race([waitTillCompletionPromise, resolveFast()]);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
        expect(semaphore.availableWeight).toBe(totalAllowedWeight - jobWeight);
        completeCurrentJob();
        await waitTillCompletionPromise;
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test(
      'waitForCompletion: should process only one job at a time, ' +
      'when the max concurrency is 5 and all jobs have a weight of 5, and are scheduled concurrently', async () => {
      const totalAllowedWeight = 5;
      const jobWeight = totalAllowedWeight; // Each job consumes all the allowed weight.
      const maxConcurrentJobs = 1;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        maxConcurrentJobs // Accurate estimation.
      );        

      const numberOfJobs = 20;
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitTillCompletionPromises: Promise<void>[] = [];

      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        // Jobs will be executed in the order on which they were registered.
        const waitPromise = semaphore.waitForCompletion(job, jobWeight);
        waitTillCompletionPromises.push(waitPromise);
      }

      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        // Trigger the event loop.
        await Promise.race([...waitTillCompletionPromises, resolveFast()]);
        // At this stage, all jobs are pending for execution, except one which has started.

        // At this stage, jobNo has started its execution.
        expect(semaphore.availableWeight).toBe(0); // Each job consumes all the allowed weight.
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
        expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);

        // Complete the current job.
        // Note: the order in which jobs start execution corresponds to the order in which
        // `waitTillCompletion` was invoked.
        const finishCurrentJob = jobCompletionCallbacks[0];
        expect(finishCurrentJob).toBeDefined();
        finishCurrentJob();
        await waitTillCompletionPromises[0];

        // Evict the just-completed job.
        waitTillCompletionPromises.shift();
        jobCompletionCallbacks.shift();
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test(
      'waitForCompletion: should not exceed the max allowed concurrency (number of concurrently executing jobs), ' +
      'when there is a backpressure of pending jobs', async () => {
      const jobWeight = 9; // Each job has a weight of 9 units.
      const maxConcurrentJobs = 5;
      const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (in our case, all jobs have an equal weight).
      const numberOfJobs = 17 * maxConcurrentJobs - 1;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        maxConcurrentJobs // Accurate estimation.
      );

      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitTillCompletionPromises: Promise<void>[] = [];

      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        // Jobs will be executed in the order in which they were registered.
        const waitPromise = semaphore.waitForCompletion(job, jobWeight);
        waitTillCompletionPromises.push(waitPromise);
      }

      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        // Trigger the event loop, allowing the semaphore to determine which jobs can start execution.
        await Promise.race([...waitTillCompletionPromises, resolveFast()]);

        // At this stage, jobs [jobNo, min(maxConcurrentJobs, jobNo + maxConcurrentJobs - 1)] are executing.
        const remainedJobs = numberOfJobs - jobNo;
        const amountOfCurrentlyExecutingJobs = Math.min(remainedJobs, maxConcurrentJobs);
        const availableWeight = jobWeight * (maxConcurrentJobs - amountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(availableWeight);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(amountOfCurrentlyExecutingJobs);
        expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);

        // Complete the current job.
        // Note: the order in which jobs start execution corresponds to the order in which
        // `waitTillCompletion` was invoked.
        const finishCurrentJob = jobCompletionCallbacks[0];
        expect(finishCurrentJob).toBeDefined();
        finishCurrentJob();
        await waitTillCompletionPromises[0];

        waitTillCompletionPromises.shift();
        jobCompletionCallbacks.shift();
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test('waitForCompletion: should return the expected value when a job completes successfully', async () => {
      const totalAllowedWeight = 18;
      const semaphore = new ZeroBackpressureWeightedSemaphore<number>(totalAllowedWeight);
      const expectedReturnValue = -1723598;
      const job: SemaphoreJob<number> = () => Promise.resolve(expectedReturnValue);
        
      const jobWeight = 1;
      const actualReturnValue = await semaphore.waitForCompletion(job, jobWeight);

      expect(actualReturnValue).toBe(expectedReturnValue);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test('waitForCompletion: should return the expected error when a job throws', async () => {
      const totalAllowedWeight = 3;
      const semaphore = new ZeroBackpressureWeightedSemaphore<number>(totalAllowedWeight);
      const expectedThrownError = new Error("mock error");
      const job: SemaphoreJob<number> = () => Promise.reject(expectedThrownError);
      const jobWeight = totalAllowedWeight;

      try {
        await semaphore.waitForCompletion(job, jobWeight);
        expect(true).toBe(false); // This should fail, as execution should not reach this point.
      } catch (actualThrownError) {
        expect(actualThrownError).toBe(expectedThrownError);
      }

      // The semaphore stores uncaught errors only for background jobs triggered by
      // `startExecution`.
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test(
      'waitForAllExecutingJobsToComplete should resolve once all executing jobs have completed: ' +
      'setup with insufficient initial slots, triggering dynamic slot allocation. ' +
      'Jobs are resolved in FIFO order in this test', async () => {
      const jobWeight = 1; // Each job has a weight of 1 unit.
      const maxConcurrentJobs = 357;
      const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Defacto, it allows a maximum of 357 concurrent jobs, as all jobs have equal weight.
      const underestimatedMaxConcurrentJobs = 1; // Intentionally set too low, to trigger dynamic slot allocations.
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        underestimatedMaxConcurrentJobs
      );  

      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitUntilCompletionPromises: Promise<void>[] = [];

      for (let jobNo = 0; jobNo < maxConcurrentJobs; ++jobNo) {
        const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        // Jobs will be executed in the order in which they were registered.
        const waitCompletionPromise = semaphore.waitForCompletion(job, jobWeight);
        // Trigger the event loop. The waitCompletionPromise won't resolve yet;
        // however, we want to activate the semaphore's dynamic slot allocation for this job.
        // A new slot should be allocated for each job, as our initial estimate is just 1 slot,
        // but in practice, there will be 357 slots.
        await Promise.race([waitCompletionPromise, resolveFast()]);
        waitUntilCompletionPromises.push(waitCompletionPromise);
      }

      let allJobsCompleted = false;
      const waitForAllExecutingJobsToCompletePromise: Promise<void> = (async () => {
        await semaphore.waitForAllExecutingJobsToComplete();
        allJobsCompleted = true;
      })();

      // Trigger the event loop to verify that allJobsCompleted remains false.
      await Promise.race([waitForAllExecutingJobsToCompletePromise, resolveFast()]);

      // Resolve jobs one by one (sequentially) in FIFO order.
      let expectedAvailableWeight = 0; // Initially zero since all jobs are running, fully utilizing the semaphore's capacity.
      let expectedAmountOfCurrentlyExecutingJobs = maxConcurrentJobs;
      for (let jobNo = 0; jobNo < maxConcurrentJobs; ++jobNo) {
        // Pre-resolve validations.
        expect(allJobsCompleted).toBe(false);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        // Resolve one job, the oldest one.
        jobCompletionCallbacks[jobNo]();
        await Promise.race(waitUntilCompletionPromises);

        // Post-resolve validations.
        ++expectedAvailableWeight;
        --expectedAmountOfCurrentlyExecutingJobs;
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        waitUntilCompletionPromises.shift();
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      await waitForAllExecutingJobsToCompletePromise;
      expect(allJobsCompleted).toBe(true);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test(
      'waitForAllExecutingJobsToComplete should resolve once all executing jobs have completed: ' +
      'setup with insufficient initial slots, triggering dynamic slot allocation. ' +
      'Jobs are resolved in FILO order in this test', async () => {
      // FILO order for job completion times is unlikely in real life, but it’s a good edge case to test.
      // It ensures the semaphore can maintain a reference to an old job, even if its execution time exceeds
      // all others.

      const jobWeight = 1; // Each job has a weight of 1 unit.
      const maxConcurrentJobs = 445;
      const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Defacto, it allows a maximum of 357 concurrent jobs, as all jobs have equal weight.
      const underestimatedMaxConcurrentJobs = 1; // Intentionally set too low, to trigger dynamic slot allocations.
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        underestimatedMaxConcurrentJobs
      );  

      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitUntilCompletionPromises: Promise<void>[] = [];

      for (let jobNo = 0; jobNo < maxConcurrentJobs; ++jobNo) {
        const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        // Jobs will be executed in the order in which they were registered.
        const waitCompletionPromise = semaphore.waitForCompletion(job, jobWeight);
        // Trigger the event loop. The waitCompletionPromise won't resolve yet;
        // however, we want to activate the semaphore's dynamic slot allocation for this job.
        // A new slot should be allocated for each job, as our initial estimate is just 1 slot,
        // but in practice, there will be 357 slots.
        await Promise.race([waitCompletionPromise, resolveFast()]);
        waitUntilCompletionPromises.push(waitCompletionPromise);
      }

      let allJobsCompleted = false;
      const waitForAllExecutingJobsToCompletePromise: Promise<void> = (async () => {
        await semaphore.waitForAllExecutingJobsToComplete();
        allJobsCompleted = true;
      })();

      // Trigger the event loop to verify that allJobsCompleted remains false.
      await Promise.race([waitForAllExecutingJobsToCompletePromise, resolveFast()]);

      // Resolve jobs one by one (sequentially) in FILO order.
      let expectedAvailableWeight = 0; // Initially zero since all jobs are running, fully utilizing the semaphore's capacity.
      let expectedAmountOfCurrentlyExecutingJobs = maxConcurrentJobs;
      for (let jobNo = 0; jobNo < maxConcurrentJobs; ++jobNo) {
        // Pre-resolve validations.
        expect(allJobsCompleted).toBe(false);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        // Resolve one job, the newest one.
        jobCompletionCallbacks.pop()();
        await Promise.race(waitUntilCompletionPromises);

        // Post-resolve validations.
        ++expectedAvailableWeight;
        --expectedAmountOfCurrentlyExecutingJobs;
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        waitUntilCompletionPromises.pop();
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      await waitForAllExecutingJobsToCompletePromise;
      expect(allJobsCompleted).toBe(true);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test('startExecution: background jobs should not exceed the max allowed concurrency', async () => {
      const jobWeight = 17; // Each job has a weight of 17 units.
      const maxConcurrentJobs = 5;
      const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (in our case, all jobs have an equal weight).
      const numberOfJobs = 6 * maxConcurrentJobs - 1;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        maxConcurrentJobs // Accurate estimation.
      );
      const jobCompletionCallbacks: (() => void)[] = [];

      // Each main iteration starts execution of the current jobNo, and completes the
      // (jobNo - maxConcurrentJobs)th job if exist, to free up a slot for the newly added job.
      // To test complex scenarios, even-numbered jobs simulate success, while odd-numbered jobs
      // simulate failure by throwing an Error.
      // From the semaphore's perspective, a completed job should release its slot, regardless of
      // whether it succeeded or failed.
      let numberOfFailedJobs = 0;
      let expectedAvailableWeight = totalAllowedWeight;
      let expectedAmountOfCurrentlyExecutingJobs = 0;
      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        const shouldJobSucceed = jobNo % 2 === 0; 
        if (!shouldJobSucceed) {
          ++numberOfFailedJobs;
        }
          
        const jobPromise = new Promise<void>((res, rej) =>
          jobCompletionCallbacks[jobNo] = shouldJobSucceed ? 
            () => res() :
            () => rej(new Error("Why bad things happen to good weighted-semaphores?"))
        );
        const job: SemaphoreJob<void> = () => jobPromise;

        // Jobs will be executed in the order in which they were registered.
        const waitTillExecutionStartsPromise = semaphore.startExecution(job, jobWeight);

        if (jobNo < maxConcurrentJobs) {
          // Should start immediately.
          await waitTillExecutionStartsPromise;
          ++expectedAmountOfCurrentlyExecutingJobs;
          expectedAvailableWeight -= jobWeight;
          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
          expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
          expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
          continue;
        }

        // At this stage, jobs [jobNo - maxConcurrentJobs, jobNo - 1] are executing, whilst jobNo
        // cannot start yet (none of the currently executing ones has completed yet).
        expect(semaphore.availableWeight).toBe(0);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs);
        expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);

        // Complete the oldest job (the first to begin execution among the currently running jobs),
        // to free up available weight.
        const completeOldestJob = jobCompletionCallbacks[jobNo - maxConcurrentJobs];
        expect(completeOldestJob).toBeDefined();
        completeOldestJob();

        // After ensuring there is an available weight for the current job, wait until
        // it starts execution.
        await waitTillExecutionStartsPromise;
      }

      // Completing the remaining "tail" of still-executing jobs:
      // Each iteration of the main loop completes the current job.
      const remainedJobsSuffixStart = numberOfJobs - maxConcurrentJobs;
      for (let jobNo = remainedJobsSuffixStart; jobNo < numberOfJobs; ++jobNo) {
        const completeCurrentJob = jobCompletionCallbacks[jobNo];
        expect(completeCurrentJob).toBeDefined();
        completeCurrentJob();

        // Trigger the event loop.
        await resolveFast();
        expectedAvailableWeight += jobWeight;
        --expectedAmountOfCurrentlyExecutingJobs;

        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
      }

      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.amountOfUncaughtErrors).toBe(numberOfFailedJobs);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
    });

    test(
      'when _waitForSufficientWeight resolves, its awaiters should be executed according ' +
      'to their order in the microtasks queue', async () => {
      // This test does not directly assess the semaphore component. Instead, it verifies the
      // correctness of the slot-acquire mechanism, ensuring it honors the FIFO order of callers
      // requesting an available slot.
      // In JavaScript, it is common for a caller to create a promise (as the sole owner of
      // this promise instance) and await its resolution. It is less common for multiple promises
      // to await concurrently on the same shared promise instance. In that scenario, a pertinent
      // question arises:
      // In which *order* will the multiple awaiters be executed?
      // Short answer: according to their order in the Node.js microtasks queue.
      // Long answer:
      // When a promise is resolved, the callbacks attached to it (other promises awaiting
      // its resolution) are *queued* as microtasks. Therefore, if multiple awaiters are waiting on
      // the same shared promise instance, and the awaiters were created in a *specific* order, the
      // first awaiter will be executed first once the shared promise is resolved. This is because
      // adding a microtask (such as an async function awaiting a promise) ensures its position in
      // the microtasks queue, guaranteeing its execution before subsequent microtasks in the queue.
      // This holds true for any position, i.e., it can be generalized.

      // In the following test, a relatively large number of awaiters is chosen. The motive is
      // to observe statistical errors, which should *not* exist regardless of the input size.
      const numberOfAwaiters = 384;
      const actualExecutionOrderOfAwaiters: number[] = [];
        
      // This specific usage of one promise instance being awaited by multiple other promises
      // may remind those with a C++ background of a std::condition_variable.
      let notifyAvailableSlotExists: PromiseResolveCallbackType;
      const waitForAvailableSlot = new Promise(res => notifyAvailableSlotExists = res);

      const awaiterAskingForSlot = async (awaiterID: number): Promise<void> => {
        await waitForAvailableSlot;
        actualExecutionOrderOfAwaiters.push(awaiterID);
        // Other awaiters in the microtasks queue will now be notified about the
        // fulfillment of 'waitForAvailableSlot'.
      };

      const expectedExecutionOrder: number[] = [];
      const awaiterPromises: Promise<void>[] = [];
      for (let i = 0; i < numberOfAwaiters; ++i) {
        expectedExecutionOrder.push(i);
        awaiterPromises.push(awaiterAskingForSlot(i));
      }

      // Initially, no awaiter should be able to make progress.
      await Promise.race([...awaiterPromises, resolveFast()]);
      expect(actualExecutionOrderOfAwaiters.length).toBe(0);

      // Notify that a slot is available, triggering the awaiters in order.
      notifyAvailableSlotExists();
      await Promise.all(awaiterPromises);

      // The execution order should match the expected order.
      expect(actualExecutionOrderOfAwaiters).toEqual(expectedExecutionOrder);;
    });
  });

  describe('Negative path tests', () => {  
    test('should capture uncaught errors from background jobs triggered by startExecution', async () => {
      const jobWeight = 1; // Each job has a weight of 1 unit.
      const totalAllowedWeight = 17 * jobWeight;
      const numberOfJobs = totalAllowedWeight + 18 * jobWeight;
      const jobErrors: CustomJobError[] = [];
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
  
      for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
        const error: CustomJobError = {
          name: "CustomJobError",
          message: `Job no. ${jobNo} has failed`,
          jobID: jobNo
        };
        jobErrors.push(error);
  
        await semaphore.startExecution(
          async () => { throw error; },
          jobWeight
        );
      }
  
      // Graceful termination, enabling us to perform deterministic validations afterwards.
      await semaphore.waitForAllExecutingJobsToComplete();
  
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.amountOfUncaughtErrors).toBe(numberOfJobs);
      expect(semaphore.extractUncaughtErrors()).toEqual(jobErrors); // Validates content of errors + their FIFO order.
      // Following extraction, the semaphore no longer holds the error references.
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });
  });
});
