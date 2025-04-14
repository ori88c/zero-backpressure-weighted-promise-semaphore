"use strict";
/**
 * Copyright 2024 Ori Cohen https://github.com/ori88c
 * https://github.com/ori88c/zero-backpressure-weighted-promise-semaphore
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
Object.defineProperty(exports, "__esModule", { value: true });
const zero_backpressure_weighted_promise_semaphore_1 = require("./zero-backpressure-weighted-promise-semaphore");
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
const sampleRandomNaturalNumber = (maxInclusive) => 1 + Math.floor(Math.random() * maxInclusive);
// This test suite focuses on the correct handling of weighted jobs.
describe('ZeroBackpressureWeightedSemaphore varying weights tests', () => {
    describe('Happy path tests', () => {
        test('should create a sufficient amount of slots during runtime, when the initial estimation is too low', async () => {
            // The ith job (i is 0-indexed) will have a weight of i+1.
            // We choose a totalAllowedWeight such that all jobs can be executed concurrently.
            const numberOfJobs = 27;
            const totalAllowedWeight = (numberOfJobs * (numberOfJobs + 1)) / 2; // Sufficient for all the jobs to execute concurrently.
            const underestimatedMaxConcurrentJobs = 1; // Intentionally set too low, to active the semaphore's dynamic slots allocation mechanism.
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, underestimatedMaxConcurrentJobs);
            let expectedAvailableWeight = totalAllowedWeight;
            let expectedAmountOfCurrentlyExecutingJobs = 0;
            const jobCompletionCallbacks = [];
            for (let ithJob = 0; ithJob < numberOfJobs; ++ithJob) {
                const jobPromise = new Promise((res) => (jobCompletionCallbacks[ithJob] = res));
                const job = () => jobPromise;
                const weight = ithJob + 1;
                await semaphore.startExecution(job, weight); // We expect it to start immediately, as the total weight is sufficient.
                ++expectedAmountOfCurrentlyExecutingJobs;
                expectedAvailableWeight -= weight;
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            }
            expect(semaphore.availableWeight).toBe(0); // totalAllowedWeight is set to the sum of all job weights.
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(numberOfJobs);
            for (let ithJob = 0; ithJob < numberOfJobs; ++ithJob) {
                jobCompletionCallbacks[ithJob]();
                await resolveFast(); // Trigger the event loop.
                const weight = ithJob + 1;
                expectedAvailableWeight += weight;
                --expectedAmountOfCurrentlyExecutingJobs;
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            }
            await semaphore.waitForAllExecutingJobsToComplete();
            expect(semaphore.amountOfUncaughtErrors).toBe(0);
        });
        // prettier-ignore
        test('when each weighted job consumes more than half of the total allowed weight, ' +
            'each job must wait for the previous one to complete, i.e., they run sequantially', async () => {
            const numberOfJobs = 30;
            const totalAllowedWeight = 180;
            const maxConcurrentJobs = 1;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            const getRandomWeightAboveHalfTotal = () => {
                return 1 + totalAllowedWeight / 2 + Math.floor(Math.random() * (totalAllowedWeight / 2));
            };
            let expectedAvailableWeight = totalAllowedWeight;
            let completePreviousJob;
            let previousJobWeight = 0;
            for (let ithJob = 0; ithJob < numberOfJobs; ++ithJob) {
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
                let completeCurrentJob;
                const jobPromise = new Promise((res) => (completeCurrentJob = res));
                const job = () => jobPromise;
                const currentJobWeight = getRandomWeightAboveHalfTotal();
                const startExecutionPromise = semaphore.startExecution(job, currentJobWeight); // Attempts to acquire the weight allotment lock.
                if (ithJob === 0) {
                    // No competition.
                    await startExecutionPromise;
                }
                else {
                    // We expect resolveFast to win the race, because if a previously added job is still executing,
                    // the current job cannot start. This is due to the specific setup where each job consumes more than half
                    // of the total allowed weight.
                    await Promise.race([resolveFast(), startExecutionPromise]);
                }
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
                if (ithJob === 0) {
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
        // prettier-ignore
        test('honors the FIFO order of weight allotments: ' +
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
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const jobWeights = [6, 5, 1, 2];
            const jobCompletionCallbacks = [];
            const startExecutionPromises = [];
            let expectedAvailableWeight = totalAllowedWeight;
            const startJobExecution = (ithJob) => {
                startExecutionPromises.push(semaphore.startExecution(() => new Promise((res) => (jobCompletionCallbacks[ithJob] = res)), jobWeights[ithJob]));
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
            for (let ithJob = 1; ithJob <= 3; ++ithJob) {
                startJobExecution(ithJob);
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
            expectedAvailableWeight =
                totalAllowedWeight - jobWeights[1] - jobWeights[2] - jobWeights[3];
            expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            // Complete the 2nd, 3rd and 4th jobs one by one.
            // Validate the available weight and the reported amount of concurrently executing jobs.
            for (let ithJob = 1; ithJob <= 3; ++ithJob) {
                jobCompletionCallbacks[ithJob]();
                await resolveFast();
                --expectedAmountOfCurrentlyExecutingJobs;
                expectedAvailableWeight += jobWeights[ithJob];
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            }
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
            expect(semaphore.availableWeight).toBe(totalAllowedWeight);
            expect(semaphore.amountOfUncaughtErrors).toBe(0);
            expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
        });
        // prettier-ignore
        test('waitForCompletion stress test with randomized weights: ' +
            'validates the state with a large number of jobs having random weights', async () => {
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 1029;
            const maxPossibleJobWeight = 397;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 1270; // Large enough to detect statistical errors, if any exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const waitForCompletionPromises = [];
            const pushJob = (ithJob) => {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[ithJob] = randomWeight;
                waitForCompletionPromises[ithJob] = semaphore.waitForCompletion(() => new Promise((res) => (jobCompletionCallbacks[ithJob] = res)), randomWeight);
            };
            const executingJobs = [];
            let expectedAvailableWeight = totalAllowedWeight;
            for (let ithJob = 0; ithJob < amountOfJobs; ++ithJob) {
                pushJob(ithJob);
                const shouldStartImmediately = expectedAvailableWeight >= jobWeights[ithJob];
                if (shouldStartImmediately) {
                    // Trigger the event loop.
                    await Promise.race([waitForCompletionPromises[ithJob], resolveFast()]);
                    executingJobs.push(ithJob);
                    expectedAvailableWeight -= jobWeights[ithJob];
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
                    executingJobs.splice(
                    // Removes an item from the array, in-place.
                    randomExecutingJobIndex, 1);
                    jobCompletionCallbacks[randomOngoingJob]();
                    await waitForCompletionPromises[randomOngoingJob];
                    // Update the expected state following the completion of the random job.
                    expectedAvailableWeight += jobWeights[randomOngoingJob];
                } while (expectedAvailableWeight < jobWeights[ithJob]);
                // At this stage, we can confirm that ithJob has started its execution.
                // The allotment lock should have been released by the recently completed job.
                expectedAvailableWeight -= jobWeights[ithJob];
                executingJobs.push(ithJob);
                await Promise.race([waitForCompletionPromises[ithJob], resolveFast()]);
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
        // prettier-ignore
        test('startExecution stress test with randomized weights: ' +
            'validates the state with a large number of jobs having random weights', async () => {
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 3070;
            const maxPossibleJobWeight = 179;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 800; // Large enough to detect statistical errors, if any exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const startExecutionPromises = [];
            const startJob = (ithJob) => {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[ithJob] = randomWeight;
                startExecutionPromises[ithJob] = semaphore.startExecution(() => new Promise((res) => (jobCompletionCallbacks[ithJob] = res)), randomWeight);
            };
            const executingJobs = [];
            let expectedAvailableWeight = totalAllowedWeight;
            for (let ithJob = 0; ithJob < amountOfJobs; ++ithJob) {
                startJob(ithJob);
                const shouldStartImmediately = expectedAvailableWeight >= jobWeights[ithJob];
                if (shouldStartImmediately) {
                    // Trigger the event loop.
                    await startExecutionPromises[ithJob];
                    executingJobs.push(ithJob);
                    expectedAvailableWeight -= jobWeights[ithJob];
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
                    executingJobs.splice(
                    // Removes an item from the array, in-place.
                    randomExecutingJobIndex, 1);
                    jobCompletionCallbacks[randomOngoingJob]();
                    await resolveFast();
                    // Update the expected state following the completion of the random job.
                    expectedAvailableWeight += jobWeights[randomOngoingJob];
                } while (expectedAvailableWeight < jobWeights[ithJob]);
                // At this stage, we can confirm that ithJob has started its execution.
                // The allotment lock should have been released by the recently completed job.
                expectedAvailableWeight -= jobWeights[ithJob];
                executingJobs.push(ithJob);
                await startExecutionPromises[ithJob];
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
        // prettier-ignore
        test('waitForCompletion stress test with intentionally induced backpressure and randomized weights: ' +
            'validates execution in FIFO order', async () => {
            // Note: While this test deliberately induces backpressure, it's not an efficient usage example.
            // Nonetheless, correctness is preserved regardless of whether backpressure prevention is considered
            // by the user.
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 704;
            const maxPossibleJobWeight = 31;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 1270; // Large enough to detect statistical errors, if any exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const waitForCompletionPromises = [];
            // Push all jobs at once. Only the initial jobs that do not exceed the total
            // allowed weight will start execution, while the others will wait in FIFO order.
            for (let ithJob = 0; ithJob < amountOfJobs; ++ithJob) {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[ithJob] = randomWeight;
                waitForCompletionPromises[ithJob] = semaphore.waitForCompletion(() => new Promise((res) => (jobCompletionCallbacks[ithJob] = res)), randomWeight);
            }
            // Trigger the event loop.
            await Promise.race([...waitForCompletionPromises, resolveFast()]);
            // Due to the insertion order of jobs (by ascending indices), the queue necessarily
            // holds a consecutive interval (job indices wise):
            // oldestExecutingJob, oldestExecutingJob + 1, ..., newestExecutingJob
            const executingJobsQueue = [];
            // Update the queue of jobs that are initially executing.
            let expectedAvailableWeight = totalAllowedWeight;
            for (let ithJob = 0; ithJob < amountOfJobs; ++ithJob) {
                if (semaphore.availableWeight === expectedAvailableWeight)
                    break;
                executingJobsQueue.push(ithJob);
                expectedAvailableWeight -= jobWeights[ithJob];
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
        const nonNaturalNumbers = [-5, 0, -1.253, 0.97, 1.2, 54.5, 9854.001];
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
            -903.88888,
        ];
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
            57 * totalAllowedWeight + 5,
        ];
        test('constructor should throw when totalAllowedWeight is not a natural number', () => {
            for (const nonNaturalNum of nonNaturalNumbers) {
                expect(() => new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(nonNaturalNum)).toThrow();
            }
        });
        test('constructor should throw when estimatedMaxNumberOfConcurrentJobs is not a natural number', () => {
            for (const nonNaturalNum of nonNaturalNumbers) {
                expect(() => new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, nonNaturalNum)).toThrow();
            }
        });
        test('startExecution should throw when jobWeight is not a natural number and less than totalAllowedWeight', () => {
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const job = () => Promise.resolve();
            for (const nonNaturalNumWeight of nonNaturalNumsLessThanTotalAllowed) {
                expect(semaphore.startExecution(job, nonNaturalNumWeight)).rejects.toThrow();
            }
        });
        test('waitForCompletion should throw when jobWeight is not a natural number and less than totalAllowedWeight', () => {
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const job = () => Promise.resolve();
            for (const nonNaturalNumWeight of nonNaturalNumsLessThanTotalAllowed) {
                expect(semaphore.waitForCompletion(job, nonNaturalNumWeight)).rejects.toThrow();
            }
        });
        test('startExecution should throw when jobWeight exceeds the totalAllowedWeight', () => {
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const job = () => Promise.resolve();
            for (const tooBigWeight of numsBiggerThanTotalAllowed) {
                expect(semaphore.startExecution(job, tooBigWeight)).rejects.toThrow();
            }
        });
        test('waitForCompletion should throw when jobWeight exceeds the totalAllowedWeight', () => {
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const job = () => Promise.resolve();
            for (const tooBigWeight of numsBiggerThanTotalAllowed) {
                expect(semaphore.waitForCompletion(job, tooBigWeight)).rejects.toThrow();
            }
        });
    });
});
//# sourceMappingURL=varying-weights.test.js.map