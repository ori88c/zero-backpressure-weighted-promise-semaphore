<h2 align="middle">Zero Backpressure Weighted Promise Semaphore</h2>

The `ZeroBackpressureWeightedSemaphore` class implements a modern Promise Semaphore for Node.js projects, allowing users to limit the concurrency of **weighted** jobs.

Each job is associated with a natural-number weight (1, 2, 3, ...). The semaphore guarantees that the total weight of concurrently executing jobs never exceeds a user-defined limit. The use of natural numbers for weights is mandated to prevent floating-point precision issues inherent in JavaScript.

This implementation does not queue pending jobs. Instead, the API promotes a **just-in-time** approach via communicative API that signals availability, thereby eliminating backpressure. As a result, users have better control over memory footprint, which enhances performance by reducing garbage-collector overhead.  
Additionally, built-in mechanisms for **error handling** and **graceful termination** are provided, ensuring that all currently executing jobs complete before termination or post-processing.

The design addresses the two primary semaphore use cases in Node.js:
* __Multiple Jobs Execution__: This use case involves a single caller dispatching multiple jobs, often serving as the sole owner of the semaphore instance.
* __Single Job Execution__: In scenarios where multiple callers, such as route handlers, concurrently access the same semaphore instance. Each caller initiates a single job and relies on its outcome to proceed.

Each use case necessitates distinct handling capabilities, which will be discussed separately with accompanying examples.

## Table of Contents

* [Key Features](#key-features)
* [Modern API Design](#modern-api-design)
* [API](#api)
* [Getter Methods](#getter-methods)
* [1st use-case: Multiple Jobs Execution](#first-use-case)
* [2nd use-case: Single Job Execution](#second-use-case)
* [Graceful Termination](#graceful-termination)
* [Error Handling for Background Jobs](#error-handling)
* [Unavoidable / Implicit Backpressure](#unavoidable-backpressure)
* [Promise Semaphores Are Not Promise Pools](#not-promise-pool)
* [Naming Convention](#naming-convention)
* [License](#license)

## Key Features :sparkles:<a id="key-features"></a>

- __Weighted Jobs :weight_lifting_woman:__: Suitable for situations where jobs have **varying** processing requirements, such as in backend applications managing resource load. For instance, consider multiple machine learning models being trained on a shared GPU resource. Each model demands different amounts of GPU memory and processing power. A weighted semaphore can regulate the total GPU memory usage, ensuring that only a specific combination of models is trained concurrently, thus preventing the GPU capacity from being exceeded.
- __Backpressure Control__: Ideal for job workers and background services. Concurrency control alone isn't sufficient to ensure stability and performance if backpressure control is overlooked. Without backpressure control, the heap can become overloaded, resulting in space complexity of O(*semaphore-slots* + *pending-jobs*) instead of O(*semaphore-slots*).
- __Graceful Termination__: Await the completion of all currently executing jobs via the `waitForAllExecutingJobsToComplete` method.
- __High Efficiency :gear:__: All state-altering operations have a constant time complexity, O(1).
- __Comprehensive Documentation :books:__: The class is thoroughly documented, enabling IDEs to provide helpful tooltips that enhance the coding experience.
- __Robust Error Handling__: Uncaught errors from background jobs triggered by `startExecution` are captured and can be accessed using the `extractUncaughtErrors` method.
- __Metrics :bar_chart:__: The class offers various metrics through getter methods, providing insights into the semaphore's current state.
- __Tests :test_tube:__: **Fully covered** by rigorous unit tests, including stress tests with randomized weights.
- Self-explanatory method names.
- No external runtime dependencies: Only development dependencies are used.
- ES2020 Compatibility: The `tsconfig` target is set to ES2020, ensuring compatibility with ES2020 environments.
- TypeScript support.

## Modern API Design :rocket:<a id="modern-api-design"></a>

Traditional semaphore APIs require explicit *acquire* and *release* steps, adding overhead and responsibility for the user. Additionally, they introduce the risk of deadlocking the application if one forgets to *release*, for example, due to a thrown exception.

In contrast, `ZeroBackpressureWeightedSemaphore` manages job execution, abstracting away these details and reducing user responsibility. The *acquire* and *release* steps are handled implicitly by the execution methods, reminiscent of the RAII idiom in C++.

Method names are chosen to clearly convey their functionality.

## API :globe_with_meridians:<a id="api"></a>

The `ZeroBackpressureWeightedSemaphore` class provides the following methods:

* __startExecution__: Resolves once the given job has **started** its execution. Users can leverage this to prevent backpressure of pending jobs; If the semaphore is too busy to start a given job `X`, there is no reason to create another job `Y` until `X` has started. This method is particularly useful for background job workers that frequently retrieve job metadata from external sources, such as pulling messages from a message broker.
* __waitForCompletion__: Executes the given job in a controlled manner, once there is an available slot. It resolves or rejects when the job **completes** execution, returning the job's value or propagating any error it may throw.
* __waitForAllExecutingJobsToComplete__: Resolves when all **currently** executing jobs have finished, meaning once all running promises have either resolved or rejected. This is particularly useful in scenarios where you need to ensure that all jobs are completed before proceeding, such as during shutdown processes or between unit tests.
* __extractUncaughtErrors__: Returns an array of uncaught errors, captured by the semaphore while executing background jobs added by `startExecution`. The instance will no longer hold these error references once extracted. In other words, ownership of these uncaught errors shifts to the caller, while the semaphore clears its list of uncaught errors.

If needed, refer to the code documentation for a more comprehensive description of each method.

## Getter Methods :mag:<a id="getter-methods"></a>

The `ZeroBackpressureWeightedSemaphore` class provides the following getter methods to reflect the current state:

* __totalAllowedWeight__: The maximum allowed sum of weights (inclusive) for jobs executed concurrently. This value is set in the constructor and remains constant throughout the instance's lifespan.
* __availableWeight__: The currently available, non-allotted amount of weight.
* __amountOfCurrentlyExecutingJobs__: The number of jobs currently being executed by the semaphore.
* __amountOfUncaughtErrors__: The number of uncaught errors from background jobs triggered by `startExecution`, that are currently stored by the instance. These errors have not yet been extracted using `extractUncaughtErrors`.

To eliminate any ambiguity, all getter methods have **O(1)** time and space complexity, meaning they do **not** iterate through all currently executing jobs with each call. The metrics are maintained by the jobs themselves.

## 1st use-case: Multiple Jobs Execution :man_technologist:<a id="first-use-case"></a>

This semaphore variant excels in eliminating backpressure when dispatching multiple concurrent jobs from the same caller. This pattern is typically observed in **background job services**, such as:
- Log File analysis.
- Network Traffic analyzers.
- Vulnerability scanning.
- Malware Signature updates.
- Sensor Data aggregation.
- Remote Configuration changes.
- Batch Data processing.

Here, the start time of each job is crucial. Since a pending job cannot start its execution until the semaphore allows, there is no benefit to adding additional jobs that cannot start immediately. The `startExecution` method communicates the job's start time to the caller (resolves as soon as the job starts), which enables to create a new job as-soon-as it makes sense.

For example, consider an application responsible for training 1M Machine Learning models, on a shared GPU resource. Different models require different amounts of GPU memory and processing power. A weighted semaphore can manage the total GPU memory usage, allowing only certain combinations of models to train concurrently. Being specific, combinations which do not exceed the GPU capacity.  
Rather than pre-creating 1M jobs (one for each model), which could potentially overwhelm the Node.js task queue and induce backpressure, the system should adopt a **just-in-time** approach. This means creating a model-training job **only when the semaphore indicates availability**, thereby optimizing resource utilization and maintaining system stability.

Note: method `waitForAllExecutingJobsToComplete` can be used to perform post-processing, after all jobs have completed. It complements the typical use-cases of `startExecution`.

```ts
import {
  ZeroBackpressureWeightedSemaphore,
  SemaphoreJob
} from 'zero-backpressure-weighted-promise-semaphore';

interface ModelInfo {
  weight: number; // Must be a natural number: 1,2,3,...
  // Additional model fields.
};

const totalAllowedWeight = 180;
const estimatedMaxNumberOfConcurrentJobs = 12;
const trainingSemaphore = new ZeroBackpressureWeightedSemaphore<void>(
  totalAllowedWeight,
  estimatedMaxNumberOfConcurrentJobs // Optional argument; can reduce dynamic slot allocations for optimization purposes.
);

async function trainModels(models: ReadonlyArray<ModelInfo>) {
  for (const model of models) {
    // Until the semaphore can start training the current model, adding more
    // jobs won't make sense as this would induce unnecessary backpressure.
    await trainingSemaphore.startExecution(
      (): Promise<void> => handleModelTraining(model),
      model.weight
    );
  }
  // Note: at this stage, jobs might be still executing, as we did not wait for
  // their completion.

  // Graceful termination: await the completion of all currently executing jobs.
  await trainingSemaphore.waitForAllExecutingJobsToComplete();
  console.info(`Finished training ${models.length} ML models`);
}

async function handleModelTraining(model: Readonly<ModelInfo>): Promise<void> {
  // Implementation goes here. 
}
```

If the jobs might throw errors, you don't need to worry about these errors propagating up to the event loop and potentially crashing the application. Uncaught errors from jobs triggered by `startExecution` are captured by the semaphore and can be safely accessed for post-processing purposes (e.g., metrics).  
Refer to the following adaptation of the above example, now utilizing the semaphore's error handling capabilities:

```ts
import {
  ZeroBackpressureWeightedSemaphore,
  SemaphoreJob
} from 'zero-backpressure-weighted-promise-semaphore';

interface ModelInfo {
  weight: number; // Must be a natural number: 1,2,3,...
  // Additional model fields.
};

interface CustomModelError extends Error {
  model: ModelInfo; // In this manner, later you can associate an error with its model.
  // Alternatively, a custom error may contain just a few fields of interest.
}

const totalAllowedWeight = 180;
const estimatedMaxNumberOfConcurrentJobs = 12;
const trainingSemaphore =
  // Notice the 2nd generic parameter (Error by default).
  new ZeroBackpressureWeightedSemaphore<void, CustomModelError>(
    totalAllowedWeight,
    estimatedMaxNumberOfConcurrentJobs // Optional argument; can reduce dynamic slot allocations for optimization purposes.
  );

async function trainModels(models: ReadonlyArray<ModelInfo>) {
  for (const model of models) {
    // Until the semaphore can start training the current model, adding more
    // jobs won't make sense as this would induce unnecessary backpressure.
    await trainingSemaphore.startExecution(
      (): Promise<void> => handleModelTraining(model),
      model.weight
    );
  }
  // Note: at this stage, jobs might be still executing, as we did not wait for
  // their completion.

  // Graceful termination: await the completion of all currently executing jobs.
  await trainingSemaphore.waitForAllExecutingJobsToComplete();

  // Post processing.
  const errors = trainingSemaphore.extractUncaughtErrors();
  if (errors.length > 0) {
    await updateFailedTrainingMetrics(errors);
  }

  // Summary:
  // The API's support for graceful termination is particularly valuable for handling
  // post-processing or clean-up tasks after the main operations are complete.
  const successfulJobsCount = models.length - errors.length;
  logger.info(
    `Successfully trained ${successfulJobsCount} models, ` +
    `with failures in training ${errors.length} models`
  );
}

async function handleModelTraining(model: Readonly<ModelInfo>): Promise<void> {
  // Implementation goes here. 
}
```

Please note that in a real-world scenario, models may be consumed from a message queue (e.g., RabbitMQ, Kafka, AWS SNS) rather than from an in-memory array. This setup **highlights the benefits** of avoiding backpressure:  
Working with message queues typically involves acknowledgements, which have **timeout** mechanisms. Therefore, immediate processing is crucial to ensure efficient and reliable handling of messages. Backpressure on the semaphore means that messages experience longer delays before their corresponding jobs start execution.  
Refer to the following adaptation of the previous example, where models are consumed from a message queue. This example overlooks error handling and message validation, for simplicity.

```ts
import {
  ZeroBackpressureWeightedSemaphore,
  SemaphoreJob
} from 'zero-backpressure-weighted-promise-semaphore';

interface ModelInfo {
  weight: number; // Must be a natural number: 1,2,3,...
  // Additional model fields.
};

interface CustomModelError extends Error {
  model: ModelInfo; // In this manner, later you can associate an error with its model.
  // Alternatively, a custom error may contain just a few fields of interest.
}

const totalAllowedWeight = 180;
const estimatedMaxNumberOfConcurrentJobs = 12;
const trainingSemaphore =
  new ZeroBackpressureWeightedSemaphore<void, CustomModelError>(
    totalAllowedWeight,
    estimatedMaxNumberOfConcurrentJobs
  );

const ML_MODELS_TOPIC = "ML_MODELS_PENDING_FOR_TRAINING";
const mqClient = new GenericMessageQueueClient(ML_MODELS_TOPIC);

async function processConsumedMessages(): Promise<void> {
  let numberOfProcessedMessages = 0;

  while (true) {
    const message = await mqClient.receiveOneMessage();
    if (!message) {
      // Consider the queue as empty, for simplicity of this example.
      break;
    }

    const modelInfo: ModelInfo = message.data;
    const job = async (): Promise<void> => {
      await handleModelTraining(modelInfo);
      ++numberOfProcessedMessages;
      await mqClient.removeMessageFromQueue(message);
    };

    await trainingSemaphore.startExecution(job, modelInfo.weight);
  }
  // Note: at this stage, jobs might be still executing, as we did not wait for
  // their completion.

  // Graceful termination: await the completion of all currently executing jobs.
  await trainingSemaphore.waitForAllExecutingJobsToComplete();

  // Post processing.
  const errors = trainingSemaphore.extractUncaughtErrors();
  if (errors.length > 0) {
    await updateFailedTrainingMetrics(errors);
  }

  // Summary:
  // The API's support for graceful termination is particularly valuable for handling
  // post-processing or clean-up tasks after the main operations are complete.
  const successfulJobsCount = models.length - errors.length;
  logger.info(
    `Successfully trained ${successfulJobsCount} models, ` +
    `with failures in training ${errors.length} models`
  );
}
```

## 2nd use-case: Single Job Execution :man_technologist:<a id="second-use-case"></a>

The `waitForCompletion` method is useful for executing a sub-procedure, for which the caller must wait before proceeding with its work.

For example, consider fetching data from an external resource within a route handler. The route handler must respond (e.g., with an HTTP status 200 on success) based on the result of the fetching sub-procedure. Note that a sub-procedure may return a value or throw an error. If an error is thrown, `waitForCompletion` will propagate the error back to the caller.

The concurrency limit for such operations is typically set based on external constraints (e.g., reducing the chances of being throttled) or the desire to limit network resource usage.

Regarding **weights**, users may choose to assign heavier weights to paginated or aggregated database operations, while assigning smaller weights to simpler operations that involve fetching a single document or record. In this way, the semaphore **not only** limits concurrency but also helps manage overall database **throughput**, maintaining responsiveness by preventing overload.

```ts
import {
  ZeroBackpressureWeightedSemaphore,
  SemaphoreJob
} from 'zero-backpressure-weighted-promise-semaphore';

type UserInfo = Record<string, string>;

// Note that if the total allowed weight is N, the maximum concurrency is also N,
// since the minimum valid weight is 1 unit (weights must be natural numbers).
const totalAllowedWeight = 84;
const dbAccessSemaphore =
  new ZeroBackpressureWeightedSemaphore<void>(totalAllowedWeight);

const GET_USER_REQUEST_WEIGHT = 1; // Simple DB query, fetching just one user info.

app.get('/user/', async (req, res) => {
  // Define the sub-prodecure.
  const fetchUserInfo: SemaphoreJob<UserInfo> = async (): Promise<UserInfo> => {
    const userInfo: UserInfo = await usersDbClient.get(req.userID);
    return userInfo;
  }

  // Execute the sub-procedure in a controlled manner.
  try {
    const userInfo: UserInfo = await dbAccessSemaphore.waitForCompletion(
      fetchUserInfo,
      GET_USER_REQUEST_WEIGHT
    );
    res.status(HTTP_OK_CODE).send(userInfo);
  } catch (err) {
    // Error was thrown by the fetchUserInfo job.
    logger.error(`Failed fetching user info for userID ${req.userID} with error: ${err.message}`);
    res.status(HTTP_ERROR_CODE);
  }
});
```

## Graceful Termination :hourglass:<a id="graceful-termination"></a>

The `waitForAllExecutingJobsToComplete` method is essential for scenarios where it is necessary to wait for all ongoing jobs to finish, such as logging a success message or executing subsequent logic. Without this built-in capability, developers would have to implement periodic polling of the semaphore or other indicators to monitor progress, which can increase both implementation complexity and resource usage.

A key use case for this method is ensuring stable unit tests. Each test should start with a clean state, independent of others, to avoid interference. This prevents scenarios where a job from Test A inadvertently continues to execute during Test B.

If your component has a termination method (`stop`, `terminate`, or similar), keep that in mind.

## Error Handling for Background Jobs :warning:<a id="error-handling"></a>

Background jobs triggered by `startExecution` may throw errors. Unlike the `waitForCompletion` case, the caller has no reference to the corresponding job promise which executes in the background.

Therefore, errors from background jobs are captured by the semaphore and can be extracted using the `extractUncaughtErrors` method. Optionally, you can specify a custom `UncaughtErrorType` as the second generic parameter of the `ZeroBackpressureWeightedSemaphore` class. By default, the error type is `Error`.
```ts
const trafficAnalyzerSemaphore =
  new ZeroBackpressureWeightedSemaphore<void, TrafficAnalyzerError>(
    totalAllowedWeight
  );
```
The number of accumulated uncaught errors can be obtained via the `amountOfUncaughtErrors` getter method. This can be useful, for example, if the user wants to handle uncaught errors only after a certain threshold is reached.

Even if the user does not intend to perform error-handling with these uncaught errors, it is **important** to periodically call this method when using `startExecution` to prevent the accumulation of errors in memory.
However, there are a few exceptional cases where the user can safely avoid extracting uncaught errors:
- The number of jobs is relatively small and the process is short-lived.
- The jobs never throw errors, thus no uncaught errors are possible.

## Unavoidable / Implicit Backpressure<a id="unavoidable-backpressure"></a>

Mitigating backpressure is primarily associated with the `startExecution` method, particularly in scenarios involving multiple jobs. However, the single-job use case may certainly inflict backpressure on the Node.js micro-tasks queue.

For instance, consider a situation where 1K concurrently executing route handlers are each awaiting the completion of their own `waitForCompletion` execution, while the semaphore is unavailable. In such cases, all handlers will internally wait on the semaphore's `_waitForSufficientWeight` private property, competing to acquire the semaphore once it becomes available.

## Promise Semaphores Are Not Promise Pools<a id="not-promise-pool"></a>

The term "promise pool" is commonly used in the JavaScript community to describe promise semaphores.  
However, this terminology can be misleading. The term "pool" typically implies the **reuse of resources**, as in "thread pools" or "connection pools," where a fixed set of resources is used and **recycled**. In contrast, a promise semaphore’s primary goal is to **control concurrency** by limiting the number of jobs executing concurrently, with each job represented by a **distinct promise instance**.

Using the term "promise pool" may cause confusion, as it suggests resource reuse rather than concurrency management.

## Naming Convention :memo:<a id="naming-convention"></a>

To improve readability and maintainability, it is highly recommended to assign a use-case-specific name to your semaphore instances. This practice helps in clearly identifying the purpose of each semaphore in the codebase. Examples include:
- dbAccessSemaphore
- tokenGenerationSemaphore
- azureStorageSemaphore
- trafficAnalyzerSemaphore
- batchProcessingSemaphore

## License :scroll:<a id="license"></a>

[Apache 2.0](LICENSE)
