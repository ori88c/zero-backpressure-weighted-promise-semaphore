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

/**
 * sampleRandomNaturalNumber
 * 
 * @returns random natural number in [1, maxInclusive] 
 */
const sampleRandomNaturalNumber = (maxInclusive: number) => 1 + Math.floor(Math.random() * maxInclusive);

// This test suite focuses on the correct handling of weighted jobs.
// General semaphore functionality, not related to weights, will be tested in a separate suite.
describe('ZeroBackpressureWeightedSemaphore weighted jobs tests', () => {
  describe('Happy path tests', () => {
    test('should create a sufficient amount of slots during runtime, when the initial estimation is too low', async () => {
      // The ith job will have a weight of i (1-indexed). We choose a totalAllowedWeight 
      // such that all jobs can be executed concurrently.
      const numberOfJobs = 14;
      const totalAllowedWeight = numberOfJobs * (numberOfJobs + 1) / 2; // Sufficient for all the jobs to execute concurrently.
      const tooLowMaxConcurrentJobsEstimation = 1; // Instead numberOfJobs which's the maximum, in our test.
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        tooLowMaxConcurrentJobsEstimation
      );

      let expectedAvailableWeight = totalAllowedWeight;
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
        const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        const weight = jobNo;
        await semaphore.startExecution(job, weight); // We expect it to start immediately, as the total weight is sufficient.
        
        expectedAvailableWeight -= weight;
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(jobNo);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      expect(semaphore.availableWeight).toBe(0);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(numberOfJobs);

      for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
        jobCompletionCallbacks[jobNo]();
        await resolveFast();
        
        const weight = jobNo;
        expectedAvailableWeight += weight;
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(numberOfJobs - jobNo);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      await semaphore.waitForAllExecutingJobsToComplete();
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
    });

    test(
      'when each weighted job consumes more than half of the total allowed weight, ' +
      'each job must wait for the previous one to complete, i.e., they run sequantially', async () => {
      const numberOfJobs = 30;
      const totalAllowedWeight = 180;
      const maxConcurrentJobs = 1;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
        totalAllowedWeight,
        maxConcurrentJobs
      );

      const getRandomWeightAboveHalfTotal = (): number => {
        return 1 + totalAllowedWeight/2 + Math.floor(Math.random() * (totalAllowedWeight/2));
      };

      let expectedAvailableWeight = totalAllowedWeight;
      let completePreviousJob: PromiseResolveCallbackType;
      let previousJobWeight = 0;
      for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        let completeCurrentJob: PromiseResolveCallbackType;
        const jobPromise = new Promise<void>(res => completeCurrentJob = res);
        const job: SemaphoreJob<void> = () => jobPromise;

        const currentJobWeight = getRandomWeightAboveHalfTotal();
        const startExecutionPromise = semaphore.startExecution(job, currentJobWeight); // Acquires the weight allotment lock, if jobNo > 1

        if (jobNo === 1) {
          await startExecutionPromise;
        } else {
          // We expect resolveFast to win the race, because if a previously added job is still executing,
          // the current job cannot start. This is due to the specific setup where each job consumes more than half
          // of the total allowed weight.
          await Promise.race([resolveFast(), startExecutionPromise]);
        }

        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);

        if (jobNo === 1) {
          expectedAvailableWeight -= currentJobWeight;
          previousJobWeight = currentJobWeight;
          completePreviousJob = completeCurrentJob;
          continue;
        }

        // At this point, the current job cannot affect the available weight, as it cannot start yet.
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        // Complete the previous job.
        completePreviousJob(); // Releases the weight allotment lock.
        await startExecutionPromise;
        expectedAvailableWeight += previousJobWeight;
        expectedAvailableWeight -= currentJobWeight;
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

        // Allows the next iteration to complete the current job.
        previousJobWeight = currentJobWeight;
        completePreviousJob = completeCurrentJob;
      }

      completePreviousJob();
      await semaphore.waitForAllExecutingJobsToComplete();
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
    });

    test(
      'honors the FIFO order of weight allotments: ' +
      'should not allocate a slot for a new job until the previously awaiting job is allocated a slot, ' +
      'even if sufficient weight is available for the newer job', async () => {
      // In this test, we use a totalAllowedWeight of 10 and four jobs with weights 6, 5, 1, and 2.
      // The expected timeline of operations is as follows (from left to right):
      // 1. startExecution of the job with weight 6. We expect it to start immediately since the semaphore is available.
      // 2. startExecution of the job with weight 5. We expect it to acquire the allotment-lock, as there is insufficient
      //    available weight (only 4 units are free out of 10) due to the ongoing first job.
      // 3. startExecution of the job with weight 1. It will not start immediately, as it must wait for the completion of
      //    the second job to release the allotment-lock, in accordance with the FIFO order.
      // 4. startExecution of the job with weight 2. Similarly, it will not start immediately despite sufficient weight
      //    being available, as the semaphore adheres to FIFO order.
      // 5. Completion of the job with weight 6.
      // 6. At this point, we expect the remaining three jobs to start immediately (one after the other), as their total
      //    weight (5 + 1 + 2 = 8) is less than the total allowed weight.
      const totalAllowedWeight = 10;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(totalAllowedWeight);

      const jobWeights: readonly number[] = [6,5,1,2];
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const startExecutionPromises: Promise<void>[] = [];
      let expectedAvailableWeight = totalAllowedWeight;

      const startJobExecution = (jobIndex: number): void => {
        startExecutionPromises.push(
          semaphore.startExecution(
            () => new Promise<void>(res => jobCompletionCallbacks[jobIndex] = res),
            jobWeights[jobIndex]
          )
        );
      };

      // First job should start immediately.
      startJobExecution(0);
      await startExecutionPromises[0];
      expectedAvailableWeight -= jobWeights[0];
      expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);

      // The second job won't start immediately due to insufficient weight.
      // It will acquire the allotment lock, preventing any other jobs from starting before it.
      // The 3rd and 4th jobs also won't start, *despite* sufficient available weight,
      // because the 2nd job has not started yet. 
      // This demonstrates that the semaphore honors the FIFO order of job insertion, i.e.,
      // available weight alone is not a sufficient condition for slot allotment.
      for (let jobIndex = 1; jobIndex <= 3; ++jobIndex) {
        startJobExecution(jobIndex);
        await resolveFast();
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight); // No change.
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
      }

      // Complete the 1st job.
      jobCompletionCallbacks[0]();
      startExecutionPromises.shift();
      // All other jobs are expected to start successfully, as their total weight is
      // 5+1+2 which is less than 10.
      await Promise.all([startExecutionPromises]);
      await resolveFast();

      let expectedAmountOfCurrentlyExecutingJobs = 3;
      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
      expectedAvailableWeight = totalAllowedWeight - jobWeights[1] - jobWeights[2] - jobWeights[3];
      expect(semaphore.availableWeight).toBe(expectedAvailableWeight);

      // Complete the 2nd, 3rd and 4th jobs one by one.
      // Validate the available weight and the reported amount of concurrently executing jobs.
      for (let jobIndex = 1; jobIndex <= 3; ++jobIndex) {
        jobCompletionCallbacks[jobIndex]();
        await resolveFast();
        --expectedAmountOfCurrentlyExecutingJobs;
        expectedAvailableWeight += jobWeights[jobIndex];
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
    });

    test(
      'waitForCompletion stress test with randomized weights: ' +
      'validates the state with a large number of jobs having random weights', async () => {
      // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
      const totalAllowedWeight = 1029;
      const maxPossibleJobWeight = 397;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(totalAllowedWeight);

      const amountOfJobs = 1270; // Large enough to detect statistical errors, if any exist.
      const jobWeights: number[] = [];
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitForCompletionPromises: Promise<void>[] = [];

      const pushJob = (jobIndex: number): void => {
        const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
        jobWeights[jobIndex] = randomWeight;

        waitForCompletionPromises[jobIndex] = semaphore.waitForCompletion(
          () => new Promise<void>(res => jobCompletionCallbacks[jobIndex] = res),
          randomWeight
        );
      };

      const executingJobs: number[] = [];
      let expectedAvailableWeight = totalAllowedWeight;
      for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
        pushJob(currJob);

        const shouldStartImmediately = expectedAvailableWeight >= jobWeights[currJob];
        if (shouldStartImmediately) {
          // Trigger the event loop.
          await Promise.race([waitForCompletionPromises[currJob], resolveFast()]);

          executingJobs.push(currJob);
          expectedAvailableWeight -= jobWeights[currJob];

          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
          expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
          continue;
        }

        // The current job cannot start immediately due to insufficient available weight.
        // It has acquired the allotment lock and is waiting for the completion of one or more ongoing jobs.
        do {
          // Randomly select an ongoing job and complete it.
          // This will increase the available weight.
          expect(executingJobs.length).toBeGreaterThan(0);
          const randomExecutingJobIndex = Math.floor(Math.random() * executingJobs.length);
          expect(randomExecutingJobIndex).toBeLessThan(executingJobs.length);
          const randomOngoingJob = executingJobs[randomExecutingJobIndex];
          executingJobs.splice( // Removes an item from the array, in-place.
            randomExecutingJobIndex,
            1 // Number of items to remove from the array, which is 1.
          );

          jobCompletionCallbacks[randomOngoingJob]();
          await waitForCompletionPromises[randomOngoingJob];

          // Update the expected state following the completion of the random job.
          expectedAvailableWeight += jobWeights[randomOngoingJob];
        } while (expectedAvailableWeight < jobWeights[currJob]);

        // At this stage, we can confirm that currJob has started its execution.
        // The allotment lock should have been released by the recently completed job.
        expectedAvailableWeight -= jobWeights[currJob];
        executingJobs.push(currJob);

        await Promise.race([waitForCompletionPromises[currJob], resolveFast()]);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      // Complete the leftovers, i.e., ongoing jobs.
      while (executingJobs.length > 0) {
        const remainedJob = executingJobs[0];
        executingJobs.shift();
        jobCompletionCallbacks[remainedJob]();
        await waitForCompletionPromises[remainedJob];

        expectedAvailableWeight += jobWeights[remainedJob];

        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
    });

    test(
      'startExecution stress test with randomized weights: ' +
      'validates the state with a large number of jobs having random weights', async () => {
      // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
      const totalAllowedWeight = 3070;
      const maxPossibleJobWeight = 179;
      const semaphore = new ZeroBackpressureWeightedSemaphore<void>(totalAllowedWeight);

      const amountOfJobs = 800; // Large enough to detect statistical errors, if any exist.
      const jobWeights: number[] = [];
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const startExecutionPromises: Promise<void>[] = [];

      const startJob = (jobIndex: number): void => {
        const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
        jobWeights[jobIndex] = randomWeight;

        startExecutionPromises[jobIndex] = semaphore.startExecution(
          () => new Promise<void>(res => jobCompletionCallbacks[jobIndex] = res),
          randomWeight
        );
      };

      const executingJobs: number[] = [];
      let expectedAvailableWeight = totalAllowedWeight;
      for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
        startJob(currJob);

        const shouldStartImmediately = expectedAvailableWeight >= jobWeights[currJob];
        if (shouldStartImmediately) {
          // Trigger the event loop.
          await startExecutionPromises[currJob];

          executingJobs.push(currJob);
          expectedAvailableWeight -= jobWeights[currJob];

          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
          expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
          continue;
        }

        // The current job cannot start immediately due to insufficient available weight.
        // It has acquired the allotment lock and is waiting for the completion of one or more ongoing jobs.
        do {
          // Randomly select an ongoing job and complete it.
          // This will increase the available weight.
          expect(executingJobs.length).toBeGreaterThan(0);
          const randomExecutingJobIndex = Math.floor(Math.random() * executingJobs.length);
          expect(randomExecutingJobIndex).toBeLessThan(executingJobs.length);
          const randomOngoingJob = executingJobs[randomExecutingJobIndex];
          executingJobs.splice( // Removes an item from the array, in-place.
            randomExecutingJobIndex,
            1 // Number of items to remove from the array, which is 1.
          );
          
          jobCompletionCallbacks[randomOngoingJob]();
          await resolveFast();

          // Update the expected state following the completion of the random job.
          expectedAvailableWeight += jobWeights[randomOngoingJob];
        } while (expectedAvailableWeight < jobWeights[currJob]);

        // At this stage, we can confirm that currJob has started its execution.
        // The allotment lock should have been released by the recently completed job.
        expectedAvailableWeight -= jobWeights[currJob];
        executingJobs.push(currJob);

        await startExecutionPromises[currJob];
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      // Complete the leftovers, i.e. ongoing jobs.
      while (executingJobs.length > 0) {
        const remainedJob = executingJobs[0];
        executingJobs.shift();
        jobCompletionCallbacks[remainedJob]();
        await startExecutionPromises[remainedJob];
        await resolveFast();

        expectedAvailableWeight += jobWeights[remainedJob];

        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
        expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
      }

      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
    });

    test(
      'waitForCompletion stress test with intentionally induced backpressure and randomized weights: ' +
      'validates execution in FIFO order', async () => {
      // Note: While this test deliberately induces backpressure, it's not an efficient usage example.
      // Nonetheless, correctness is preserved regardless of whether backpressure prevention is considered
      // by the user.

      // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
      const totalAllowedWeight = 704;
      const maxPossibleJobWeight = 31;
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);

      const amountOfJobs = 1270; // Large enough to detect statistical errors, if any exist.
      const jobWeights: number[] = [];
      const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
      const waitForCompletionPromises: Promise<void>[] = [];

      // Push all jobs at once. Only the initial jobs that do not exceed the total
      // allowed weight will start execution, while the others will wait in FIFO order.
      for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
        const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
        jobWeights[currJob] = randomWeight;

        waitForCompletionPromises[currJob] = semaphore.waitForCompletion(
          () => new Promise<void>(res => jobCompletionCallbacks[currJob] = res),
          randomWeight
        );
      }

      // Trigger the event loop.
      await Promise.race([...waitForCompletionPromises, resolveFast()]);

      // Due to the insertion order of jobs (by ascending indices), the queue necessarily
      // holds a consecutive interval (job indices wise):
      // oldestExecutingJob, oldestExecutingJob + 1, ..., newestExecutingJob
      const executingJobsQueue: number[] = [];
      
      // Update the queue of jobs that are initially executing.
      let expectedAvailableWeight = totalAllowedWeight;
      for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
        if (semaphore.availableWeight === expectedAvailableWeight)
          break;

        executingJobsQueue.push(currJob);
        expectedAvailableWeight -= jobWeights[currJob];
      }

      do {
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobsQueue.length);

        // Complete the oldest currently executing job.
        const oldestExecutingJob = executingJobsQueue[0];
        executingJobsQueue.shift(); // Pop the first-in from the queue.
        jobCompletionCallbacks[oldestExecutingJob]();
        expectedAvailableWeight += jobWeights[oldestExecutingJob];
        await waitForCompletionPromises[oldestExecutingJob];
        await resolveFast();

        // It's possible that more jobs have started execution now, as an allotment lock was just released.
        // In other words, the completion of the last job has freed up additional weight.
        while (semaphore.availableWeight < expectedAvailableWeight) {
          const justStartedJob = executingJobsQueue[executingJobsQueue.length - 1] + 1;
          executingJobsQueue.push(justStartedJob);
          expectedAvailableWeight -= jobWeights[justStartedJob];
        }
      } while (expectedAvailableWeight < totalAllowedWeight);

      expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
      expect(semaphore.availableWeight).toBe(totalAllowedWeight);
      expect(semaphore.amountOfUncaughtErrors).toBe(0);
      expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
    });
  });

  describe('Negative path tests', () => {
    const nonNaturalNumbers = [ -5, 0, -1.253, 0.97, 1.2, 54.5, 9854.001 ] as const;
    const totalAllowedWeight = 50;
    const nonNaturalNumsLessThanTotalAllowed = [
      totalAllowedWeight - 0.0001,
      totalAllowedWeight - 0.4,
      totalAllowedWeight - 4.78,
      totalAllowedWeight - 45.9999,
      totalAllowedWeight - 16.6666667,
      -totalAllowedWeight,
      0,
      -1,
      -5,
      -900,
      0.003,
      -0.00001,
      -903.88888
    ] as const;
    const numsBiggerThanTotalAllowed = [
      totalAllowedWeight + 0.0001,
      totalAllowedWeight + 0.4,
      totalAllowedWeight + 4.78,
      totalAllowedWeight + 45.9999,
      totalAllowedWeight + 16.6666667,
      totalAllowedWeight + 1,
      totalAllowedWeight + 341,
      totalAllowedWeight + 584004,
      2 * totalAllowedWeight + 5,
      7 * totalAllowedWeight - 1,
      57 * totalAllowedWeight + 5
    ] as const;

    test('constructor should throw when totalAllowedWeight is not a natural number', () => {
      for (const nonNaturalNum of nonNaturalNumbers) {
        expect(() => new ZeroBackpressureWeightedSemaphore<void>(nonNaturalNum)).toThrow();
      }
    });

    test('constructor should throw when estimatedMaxNumberOfConcurrentJobs is not a natural number', () => {
      for (const nonNaturalNum of nonNaturalNumbers) {
        expect(
          () => new ZeroBackpressureWeightedSemaphore<void>(
            totalAllowedWeight,
            nonNaturalNum
          )
        ).toThrow();
      }
    });

    test('startExecution should throw when jobWeight is not a natural number and less than totalAllowedWeight', () => {
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
      const job = () => Promise.resolve();

      for (const nonNaturalNumWeight of nonNaturalNumsLessThanTotalAllowed) {
        expect(semaphore.startExecution(job, nonNaturalNumWeight)).rejects.toThrow();
      }
    });

    test('waitForCompletion should throw when jobWeight is not a natural number and less than totalAllowedWeight', () => {
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
      const job = () => Promise.resolve();

      for (const nonNaturalNumWeight of nonNaturalNumsLessThanTotalAllowed) {
        expect(semaphore.waitForCompletion(job, nonNaturalNumWeight)).rejects.toThrow();
      }
    });

    test('startExecution should throw when jobWeight exceeds the totalAllowedWeight', () => {
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
      const job = () => Promise.resolve();

      for (const tooBigWeight of numsBiggerThanTotalAllowed) {
        expect(semaphore.startExecution(job, tooBigWeight)).rejects.toThrow();
      }
    });

    test('waitForCompletion should throw when jobWeight exceeds the totalAllowedWeight', () => {
      const semaphore = new ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
      const job = () => Promise.resolve();

      for (const tooBigWeight of numsBiggerThanTotalAllowed) {
        expect(semaphore.waitForCompletion(job, tooBigWeight)).rejects.toThrow();
      }
    });
  });
});

// The equal-weight jobs tests are adaptation of the non-weighted variant tests:
// https://github.com/ori88c/zero-backpressure-semaphore-typescript
// They focus on the semaphore's functionality, more than validating correct handling of
// weighted scenarios.
describe('ZeroBackpressureWeightedSemaphore equal-weight jobs tests', () => {
    describe('Happy path tests', () => {
      test(
        'waitForCompletion: should process only one job at a time, ' +
        'when jobs happen to be scheduled sequentially (trivial case)', async () => {
        const totalAllowedWeight = 7;
        const maxConcurrentJobs = totalAllowedWeight; // Each job will have a 1 unit of weight.
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
          const waitTillCompletionPromise: Promise<void> = semaphore.waitForCompletion(job, 1);
          await resolveFast();
          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
          expect(semaphore.availableWeight).toBe(totalAllowedWeight - 1);
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
          maxConcurrentJobs
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
          maxConcurrentJobs
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

      test('waitForAllExecutingJobsToComplete: should resolve once all executing jobs are completed', async () => {
        const jobWeight = 1; // Each job has a weight of 1 unit.
        const maxConcurrentJobs = 12;
        const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 12 concurrent jobs (in our case, all jobs have an equal weight).
        const numberOfJobs = maxConcurrentJobs;
        const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
          totalAllowedWeight,
          maxConcurrentJobs
        );  

        const jobCompletionCallbacks: PromiseResolveCallbackType[] = [];
        const waitTillCompletionPromises: Promise<void>[] = [];

        for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
          const jobPromise = new Promise<void>(res => jobCompletionCallbacks[jobNo] = res);
          const job: SemaphoreJob<void> = () => jobPromise;

          // Jobs will be executed in the order in which they were registered.
          const waitCompletionPromise = semaphore.waitForCompletion(job, jobWeight);
          waitTillCompletionPromises.push(waitCompletionPromise);
        }

        const waitForAllExecutingJobsToCompletePromise = semaphore.waitForAllExecutingJobsToComplete();
        await resolveFast(); // Trigger the event loop.

        // Resolve jobs one by one (sequentially).
        for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
          // Pre-resolve validations.
          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs - jobNo);
          expect(semaphore.availableWeight).toBe(jobNo);

          // Resolve one job.
          jobCompletionCallbacks[jobNo]();
          await Promise.race(waitTillCompletionPromises);

          // Post-resolve validations.
          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs - jobNo - 1);
          expect(semaphore.availableWeight).toBe(jobNo + 1);

          waitTillCompletionPromises.shift();
        }

        expect(semaphore.availableWeight).toBe(totalAllowedWeight);
        expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
        await waitForAllExecutingJobsToCompletePromise;
        expect(semaphore.amountOfUncaughtErrors).toBe(0);
      });

      test('startExecution: background jobs should not exceed the max allowed concurrency', async () => {
        const jobWeight = 17; // Each job has a weight of 17 units.
        const maxConcurrentJobs = 5;
        const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (in our case, all jobs have an equal weight).
        const numberOfJobs = 6 * maxConcurrentJobs - 1;
        const semaphore = new ZeroBackpressureWeightedSemaphore<void>(
          totalAllowedWeight,
          maxConcurrentJobs
        );
        const jobCompletionCallbacks: (() => void)[] = [];

        // Each main iteration starts execution of the current jobNo, and completes the
        // (jobNo - maxConcurrentJobs)th job if exist, to free up a slot for the newly added job.
        // To test complex scenarios, even-numbered jobs simulate success, while odd-numbered jobs
        // simulate failure by throwing an Error.
        // From the semaphore's perspective, a completed job should release its slot, regardless of
        // whether it succeeded or failed.
        let numberOfFailedJobs = 0;
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
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(jobNo + 1);
            expect(semaphore.availableWeight).toBe(totalAllowedWeight - jobWeight * (jobNo + 1));
            expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
            continue;
          }

          // At this stage, jobs [jobNo - maxConcurrentJobs, jobNo - 1] are executing, whilst jobNo
          // cannot start yet (none of the currently executing ones has completed yet).
          expect(semaphore.availableWeight).toBe(0);
          expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs);
          expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);

          // Complete the oldest job (the first to begin execution among the currently running jobs).
          const completeOldestJob = jobCompletionCallbacks[jobNo - maxConcurrentJobs];
          expect(completeOldestJob).toBeDefined();
          completeOldestJob();

          // Wait until jobNo starts executing, after ensuring there is an available slot for it.
          await waitTillExecutionStartsPromise;
        }

        // Completing the remaining "tail" of still-executing jobs:
        // Each iteration of the main loop completes the current job.
        let expectedAvailableWeight = 0;
        let expectedAmountOfCurrentlyExecutingJobs = maxConcurrentJobs;
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
        }

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
