"use strict";
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
// General semaphore functionality, not related to weights, will be tested in a separate suite.
describe('ZeroBackpressureWeightedSemaphore weighted jobs tests', () => {
    describe('Happy path tests', () => {
        test('should create a sufficient amount of slots during runtime, when the initial estimation is too low', async () => {
            // The ith job will have a weight of i (1-indexed). We choose a totalAllowedWeight 
            // such that all jobs can be executed concurrently.
            const numberOfJobs = 14;
            const totalAllowedWeight = numberOfJobs * (numberOfJobs + 1) / 2; // Sufficient for all the jobs to execute concurrently.
            const tooLowMaxConcurrentJobsEstimation = 1; // Instead numberOfJobs which's the maximum, in our test.
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, tooLowMaxConcurrentJobsEstimation);
            let expectedAvailableWeight = totalAllowedWeight;
            const jobCompletionCallbacks = [];
            for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
                const jobPromise = new Promise(res => jobCompletionCallbacks[jobNo] = res);
                const job = () => jobPromise;
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
        test('when each weighted job consumes more than half of the total allowed weight, each job must await for ' +
            'its previous to complete, i.e. they run sequantially', async () => {
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
            for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
                let completeCurrentJob;
                const jobPromise = new Promise(res => completeCurrentJob = res);
                const job = () => jobPromise;
                const currentJobWeight = getRandomWeightAboveHalfTotal();
                const startExecutionPromise = semaphore.startExecution(job, currentJobWeight); // Acquires the weight allotment lock, if jobNo > 1.
                if (jobNo === 1)
                    await startExecutionPromise;
                else {
                    // We expect resolveFast to win the race, as if a previously added job is currently executing,
                    // the current job won't be able to start. Due to the specific setup, on which each job requires
                    // more than half of the total weight.
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
                completePreviousJob(); // Triggers a release of the weight allotment lock.
                await startExecutionPromise;
                expectedAvailableWeight += previousJobWeight;
                expectedAvailableWeight -= currentJobWeight;
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
                // Enable the next iteration to complete the current job.
                previousJobWeight = currentJobWeight;
                completePreviousJob = completeCurrentJob;
            }
            completePreviousJob();
            await semaphore.waitForAllExecutingJobsToComplete();
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
            expect(semaphore.availableWeight).toBe(totalAllowedWeight);
        });
        test('honor the FIFO order of weight allotments: should not allot a slot for a new job, until a previous ' +
            'awaiting job is allotted with a slot first, even if there is a sufficient available weight for the newer job', async () => {
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
            const startJobExecution = (jobIndex) => {
                startExecutionPromises.push(semaphore.startExecution(() => new Promise(res => jobCompletionCallbacks[jobIndex] = res), jobWeights[jobIndex]));
            };
            // First job should start immediately.
            startJobExecution(0);
            await startExecutionPromises[0];
            expectedAvailableWeight -= jobWeights[0];
            expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
            // Second job won't succeed starting immediately, as there's no sufficient weight.
            // It'll acquire the allotment lock, and no other jobs will be able to start before
            // it does.
            // 3rd and 4th jobs won't start either, *despite* there is a sufficient available
            // weight for them, because the 2nd job has not started yet. This proves that the
            // semaphore honors the FIFO order of job insertion, i.e. available weight alone
            // is not a sufficient condition for a slot allotment.
            for (let jobIndex = 1; jobIndex <= 3; ++jobIndex) {
                startJobExecution(jobIndex);
                await resolveFast();
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight); // No change.
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
            }
            // Complete the 1st job.
            jobCompletionCallbacks[0]();
            startExecutionPromises.shift();
            // We expect all other jobs to start successfully, as their total weight is
            // 5+1+2 which is less than 10.
            await Promise.all([startExecutionPromises]);
            await resolveFast();
            let expectedAmountOfCurrentlyExecutingJobs = 3;
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(expectedAmountOfCurrentlyExecutingJobs);
            expectedAvailableWeight = totalAllowedWeight - jobWeights[1] - jobWeights[2] - jobWeights[3];
            expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            // Complete the 2nd, 3rd and 4th jobs one by one. Validate available weight and
            // reported amount of concurrently executing jobs.
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
        test('waitForCompletion stress-test with randomized weights: validating state given a setup of randomly ' +
            'weighted, big amount of jobs', async () => {
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 1029;
            const maxPossibleJobWeight = 397;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 1270; // Sufficiently big to observe statistical errors, if exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const waitForCompletionPromises = [];
            const pushJob = (jobIndex) => {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[jobIndex] = randomWeight;
                waitForCompletionPromises[jobIndex] = semaphore.waitForCompletion(() => new Promise(res => jobCompletionCallbacks[jobIndex] = res), randomWeight);
            };
            const executingJobs = [];
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
                // Current job cannot start immediately as there's no sufficient weight. It acquired the
                // allotment-lock and awaits for an ongoing-job (or multiple such) to be completed.
                do {
                    // Randomly pick one ongoing job, and complete it. It should increment the
                    // amount of available weight.
                    expect(executingJobs.length).toBeGreaterThan(0);
                    const randomExecutingJobsIndex = Math.floor(Math.random() * executingJobs.length);
                    expect(randomExecutingJobsIndex).toBeLessThan(executingJobs.length);
                    const randomOngoingJob = executingJobs[randomExecutingJobsIndex];
                    executingJobs.splice(// Removes an item from the array, in-place.
                    randomExecutingJobsIndex, 1 // Amount of items to remove from the array, which is just 1.
                    );
                    jobCompletionCallbacks[randomOngoingJob]();
                    await waitForCompletionPromises[randomOngoingJob];
                    // Update expected state, following completion of the random job.
                    expectedAvailableWeight += jobWeights[randomOngoingJob];
                } while (expectedAvailableWeight < jobWeights[currJob]);
                // At this stage, we know for sure that currJob has began its execution.
                // The allotment lock should have been released by the just-completed job.
                expectedAvailableWeight -= jobWeights[currJob];
                executingJobs.push(currJob);
                await Promise.race([waitForCompletionPromises[currJob], resolveFast()]);
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobs.length);
                expect(semaphore.availableWeight).toBe(expectedAvailableWeight);
            }
            // Complete the leftovers, i.e. ongoing jobs.
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
        test('startExecution stress-test with randomized weights: validating state given a setup of randomly ' +
            'weighted, big amount of jobs', async () => {
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 3070;
            const maxPossibleJobWeight = 179;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 800; // Sufficiently big to observe statistical errors, if exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const startExecutionPromises = [];
            const startJob = (jobIndex) => {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[jobIndex] = randomWeight;
                startExecutionPromises[jobIndex] = semaphore.startExecution(() => new Promise(res => jobCompletionCallbacks[jobIndex] = res), randomWeight);
            };
            const executingJobs = [];
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
                // Current job cannot start immediately as there's no sufficient weight. It acquired the
                // allotment-lock and awaits for an ongoing-job (or multiple such) to be completed.
                do {
                    // Randomly pick one ongoing job, and complete it. It should increment the
                    // amount of available weight.
                    expect(executingJobs.length).toBeGreaterThan(0);
                    const randomExecutingJobsIndex = Math.floor(Math.random() * executingJobs.length);
                    expect(randomExecutingJobsIndex).toBeLessThan(executingJobs.length);
                    const randomOngoingJob = executingJobs[randomExecutingJobsIndex];
                    executingJobs.splice(// Removes an item from the array, in-place.
                    randomExecutingJobsIndex, 1 // Amount of items to remove from the array, which is just 1.
                    );
                    jobCompletionCallbacks[randomOngoingJob]();
                    await resolveFast();
                    // Update expected state, following completion of the random job.
                    expectedAvailableWeight += jobWeights[randomOngoingJob];
                } while (expectedAvailableWeight < jobWeights[currJob]);
                // At this stage, we know for sure that currJob has began its execution.
                // The allotment lock should have been released by the just-completed job.
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
        test('waitForCompletion stress-test with intentionally induced backpressure, and randomized weights: ' +
            'validating execution in FIFO order', async () => {
            // Note: While this test deliberately induces backpressure, it's not an efficient usage example.
            // Nonetheless, correctness is preserved regardless of whether backpressure prevention is considered
            // by the user.
            // Higher totalAllowedWeight / maxPossibleJobWeight ratio means that more jobs will execute concurrently.
            const totalAllowedWeight = 704;
            const maxPossibleJobWeight = 31;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const amountOfJobs = 1270; // Sufficiently big to observe statistical errors, if exist.
            const jobWeights = [];
            const jobCompletionCallbacks = [];
            const waitForCompletionPromises = [];
            // Push all jobs at once. Only the prefix-jobs which do not exceed the total
            // allowed weight will actually start execution, whilst the others will wait
            // in FIFO order.
            for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
                const randomWeight = sampleRandomNaturalNumber(maxPossibleJobWeight);
                jobWeights[currJob] = randomWeight;
                waitForCompletionPromises[currJob] = semaphore.waitForCompletion(() => new Promise(res => jobCompletionCallbacks[currJob] = res), randomWeight);
            }
            // Trigger the event loop.
            await Promise.race([...waitForCompletionPromises, resolveFast()]);
            // Due to the insertion order of jobs (by ascending indices), the queue necessarily
            // holds a consecutive interval (job indices wise):
            // oldestExecutingJob, oldestExecutingJob + 1, ..., newestExecutingJob
            const executingJobsQueue = [];
            // Update which jobs are initially executing.
            let expectedAvailableWeight = totalAllowedWeight;
            for (let currJob = 0; currJob < amountOfJobs; ++currJob) {
                if (semaphore.availableWeight === expectedAvailableWeight)
                    break;
                executingJobsQueue.push(currJob);
                expectedAvailableWeight -= jobWeights[currJob];
            }
            do {
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(executingJobsQueue.length);
                // Complete the oldest executing job.
                const oldestExecutingJob = executingJobsQueue[0];
                executingJobsQueue.shift(); // Pop the first-in from the queue.
                jobCompletionCallbacks[oldestExecutingJob]();
                expectedAvailableWeight += jobWeights[oldestExecutingJob];
                await waitForCompletionPromises[oldestExecutingJob];
                await resolveFast();
                // Possibly, more jobs started execution now, as an allotment lock was just released.
                // In other words, the job which was just-completed added an available weight.
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
            -903.88888
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
            57 * totalAllowedWeight + 5
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
// The equal-weight jobs tests are adaptation of the non-weighted variant tests:
// https://github.com/ori88c/zero-backpressure-semaphore-typescript
// They focus on the semaphore's functionality, more than validating correct handling of
// weighted scenarios.
describe('ZeroBackpressureWeightedSemaphore equal-weight jobs tests', () => {
    describe('Happy path tests', () => {
        test('waitForCompletion: should process only one job at a time, when jobs happen to be scheduled sequentially (trivial case)', async () => {
            const totalAllowedWeight = 7;
            const maxConcurrentJobs = totalAllowedWeight; // Each job will have a 1 unit of weight.
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            let completeCurrentJob;
            const numberOfJobs = 10;
            for (let jobNo = 1; jobNo <= numberOfJobs; ++jobNo) {
                expect(semaphore.availableWeight).toBe(totalAllowedWeight);
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
                expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
                expect(semaphore.amountOfUncaughtErrors).toBe(0);
                const jobPromise = new Promise(res => completeCurrentJob = res);
                const job = () => jobPromise;
                const waitTillCompletionPromise = semaphore.waitForCompletion(job, 1);
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
        test('waitForCompletion: should process only one job at a time, when max concurrency is 5 and jobs of weight 5 are scheduled concurrently', async () => {
            const totalAllowedWeight = 5;
            const jobWeight = totalAllowedWeight; // Each job consumes all the allowed weight.
            const maxConcurrentJobs = 1;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            const numberOfJobs = 20;
            const jobCompletionCallbacks = [];
            const waitTillCompletionPromises = [];
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                const jobPromise = new Promise(res => jobCompletionCallbacks[jobNo] = res);
                const job = () => jobPromise;
                // Jobs will be executed in the order on which they were registered.
                const waitPromise = semaphore.waitForCompletion(job, jobWeight);
                waitTillCompletionPromises.push(waitPromise);
            }
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                // Just trigger the event loop.
                await Promise.race([...waitTillCompletionPromises, resolveFast()]);
                // At this stage, all jobs are pending for execution, except one which has started its execution.
                // At this stage, jobNo has started its execution.
                expect(semaphore.availableWeight).toBe(0); // Each job consumes all the allowed weight.
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(1);
                expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
                // Finish current job.
                // Note: the order on which jobs will be executed, is the order on which we
                // invoke semaphore.waitTillCompletion.
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
        test('waitForCompletion: should not exceed max concurrently executing jobs, when the amont of pending jobs is bigger than the amount of slots', async () => {
            const jobWeight = 9; // Each job will have a weight of 9 units.
            const maxConcurrentJobs = 5;
            const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (as in our case, all jobs have an equal weight).
            const numberOfJobs = 17 * maxConcurrentJobs - 1;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            const jobCompletionCallbacks = [];
            const waitTillCompletionPromises = [];
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                const jobPromise = new Promise(res => jobCompletionCallbacks[jobNo] = res);
                const job = () => jobPromise;
                // Jobs will be executed in the order on which they were registered.
                const waitPromise = semaphore.waitForCompletion(job, jobWeight);
                waitTillCompletionPromises.push(waitPromise);
            }
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                // Triggering the event loop, allowing the Semaphore to decide which jobs can
                // start their execution.
                await Promise.race([...waitTillCompletionPromises, resolveFast()]);
                // At this stage, jobs [jobNo, min(maxConcurrentJobs, jobNo + maxConcurrentJobs - 1)] are executing.
                const remainedJobs = numberOfJobs - jobNo;
                const amountOfCurrentlyExecutingJobs = Math.min(remainedJobs, maxConcurrentJobs);
                const availableWeight = jobWeight * (maxConcurrentJobs - amountOfCurrentlyExecutingJobs);
                expect(semaphore.availableWeight).toBe(availableWeight);
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(amountOfCurrentlyExecutingJobs);
                expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
                // Complete the current job.
                // Note: the order on which jobs will be executed, is the order on which we invoke semaphore.waitTillCompletion.
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
        test('waitForCompletion: should return the expected value when succeeds', async () => {
            const totalAllowedWeight = 18;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const expectedReturnValue = -1723598;
            const job = () => Promise.resolve(expectedReturnValue);
            const jobWeight = 1;
            const actualReturnValue = await semaphore.waitForCompletion(job, jobWeight);
            expect(actualReturnValue).toBe(expectedReturnValue);
            expect(semaphore.amountOfUncaughtErrors).toBe(0);
        });
        test('waitForCompletion: should return the expected error when throws', async () => {
            const totalAllowedWeight = 3;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            const expectedThrownError = new Error("mock error");
            const job = () => Promise.reject(expectedThrownError);
            const jobWeight = totalAllowedWeight;
            try {
                await semaphore.waitForCompletion(job, jobWeight);
                expect(true).toBe(false); // Necessarily fails, as it shouldn't reach here.
            }
            catch (actualThrownError) {
                expect(actualThrownError).toBe(expectedThrownError);
            }
            // The semaphore stores uncaught errors only for background jobs triggered by
            // `startExecution`.
            expect(semaphore.amountOfUncaughtErrors).toBe(0);
        });
        test('waitForAllExecutingJobsToComplete: should resolve once all executing jobs are completed', async () => {
            const jobWeight = 1; // Each job will have a weight of 1 unit.
            const maxConcurrentJobs = 12;
            const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (as in our case, all jobs have an equal weight).
            const numberOfJobs = maxConcurrentJobs;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            const jobCompletionCallbacks = [];
            const waitTillCompletionPromises = [];
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                const jobPromise = new Promise(res => jobCompletionCallbacks[jobNo] = res);
                const job = () => jobPromise;
                // Jobs will be executed in the order on which they were registered.
                const waitCompletionPromise = semaphore.waitForCompletion(job, jobWeight);
                waitTillCompletionPromises.push(waitCompletionPromise);
            }
            const waitForAllExecutingJobsToCompletePromise = semaphore.waitForAllExecutingJobsToComplete();
            await resolveFast(); // Trigger the event loop.
            // Resolve jobs one by one (sequentially).
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                // Before resolving.
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs - jobNo);
                expect(semaphore.availableWeight).toBe(jobNo);
                // Resolve one job.
                jobCompletionCallbacks[jobNo]();
                await Promise.race(waitTillCompletionPromises);
                // After resolving.
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs - jobNo - 1);
                expect(semaphore.availableWeight).toBe(jobNo + 1);
                waitTillCompletionPromises.shift();
            }
            expect(semaphore.availableWeight).toBe(totalAllowedWeight);
            expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(0);
            await waitForAllExecutingJobsToCompletePromise;
            expect(semaphore.amountOfUncaughtErrors).toBe(0);
        });
        test('startExecution: background jobs should not exceed the max given concurrency', async () => {
            const jobWeight = 17; // Each job will have a weight of 17 units.
            const maxConcurrentJobs = 5;
            const totalAllowedWeight = maxConcurrentJobs * jobWeight; // Max of 5 concurrent jobs (as in our case, all jobs have an equal weight).
            const numberOfJobs = 6 * maxConcurrentJobs - 1;
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight, maxConcurrentJobs);
            const jobCompletionCallbacks = [];
            // Each main iteration starts execution of the current jobNo, and completes the
            // (jobNo - maxConcurrentJobs)th job if exist, to make an available slot for
            // the just-added one.
            // To validate complex scenarios, even-numbered jobs will succeed while odd-numbered jobs
            // will throw exceptions. From the semaphore's perspective, a completed job should release
            // its associated room, regardless of whether it completed successfully or failed.
            let numberOfFailedJobs = 0;
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                const shouldJobSucceed = jobNo % 2 === 0;
                if (!shouldJobSucceed) {
                    ++numberOfFailedJobs;
                }
                const jobPromise = new Promise((res, rej) => jobCompletionCallbacks[jobNo] = shouldJobSucceed ?
                    () => res() :
                    () => rej(new Error("Why bad things happen to good weighted-semaphores?")));
                const job = () => jobPromise;
                // Jobs will be executed in the order on which they were registered.
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
                // cannot start yet (none of the currently executing ones has resulted yet).
                expect(semaphore.availableWeight).toBe(0);
                expect(semaphore.amountOfCurrentlyExecutingJobs).toBe(maxConcurrentJobs);
                expect(semaphore.totalAllowedWeight).toBe(totalAllowedWeight);
                // Finish oldest job (began executing first, among the currently executing ones).
                const completeOldestJob = jobCompletionCallbacks[jobNo - maxConcurrentJobs];
                expect(completeOldestJob).toBeDefined();
                completeOldestJob();
                // Wait until jobNo starts executing, after ensuring an available slot for it.
                await waitTillExecutionStartsPromise;
            }
            // Completing the remained "tail" of still-executing jobs:
            // Each main loop completes the current job.
            let expectedAvailableWeight = 0;
            let expectedAmountOfCurrentlyExecutingJobs = maxConcurrentJobs;
            const remainedJobsSuffixStart = numberOfJobs - maxConcurrentJobs;
            for (let jobNo = remainedJobsSuffixStart; jobNo < numberOfJobs; ++jobNo) {
                const completeCurrentJob = jobCompletionCallbacks[jobNo];
                expect(completeCurrentJob).toBeDefined();
                completeCurrentJob();
                // Just trigger the event loop.
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
        test('when _waitForSufficientWeight resolves, its awaiters should be executed according to their order in the microtasks queue', async () => {
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
            const actualExecutionOrderOfAwaiters = [];
            // This specific usage of one promise instance being awaited by multiple other promises
            // may remind those with a C++ background of a condition_variable.
            let notifyAvailableSlotExists;
            const waitForAvailableSlot = new Promise(res => notifyAvailableSlotExists = res);
            const awaiterAskingForSlot = async (awaiterID) => {
                await waitForAvailableSlot;
                actualExecutionOrderOfAwaiters.push(awaiterID);
                // Other awaiters in the microtasks queue will now be notified about the
                // fulfillment of 'waitForAvailableSlot'.
            };
            const expectedExecutionOrder = [];
            const awaiterPromises = [];
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
            expect(actualExecutionOrderOfAwaiters).toEqual(expectedExecutionOrder);
            ;
        });
    });
    describe('Negative path tests', () => {
        test('should capture uncaught errors from background jobs triggered by startExecution', async () => {
            const jobWeight = 1; // Each job will have an equal weight of 1 unit.
            const totalAllowedWeight = 17 * jobWeight;
            const numberOfJobs = totalAllowedWeight + 18 * jobWeight;
            const jobErrors = [];
            const semaphore = new zero_backpressure_weighted_promise_semaphore_1.ZeroBackpressureWeightedSemaphore(totalAllowedWeight);
            for (let jobNo = 0; jobNo < numberOfJobs; ++jobNo) {
                const error = {
                    name: "CustomJobError",
                    message: `Job no. ${jobNo} has failed`,
                    jobID: jobNo
                };
                jobErrors.push(error);
                await semaphore.startExecution(async () => { throw error; }, jobWeight);
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
//# sourceMappingURL=zero-backpressure-weighted-promise-semaphore.test.js.map