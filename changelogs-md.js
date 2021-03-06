const cdk = require('@aws-cdk/cdk');
const ecs = require('@aws-cdk/aws-ecs');
const ec2 = require('@aws-cdk/aws-ec2');
const dynamodb = require('@aws-cdk/aws-dynamodb');
const sns = require('@aws-cdk/aws-sns');
const s3 = require('@aws-cdk/aws-s3');
const s3Deployment = require('@aws-cdk/aws-s3-deployment');
const lambda = require('@aws-cdk/aws-lambda');
const lambdaEvents = require('@aws-cdk/aws-lambda-event-sources');
const apiGateway = require('@aws-cdk/aws-apigateway');
const events = require('@aws-cdk/aws-events');
const cloudfront = require('@aws-cdk/aws-cloudfront');
const redis = require('./custom-constructs/redis');
const copydir = require('copy-dir');
var fs = require('fs');

var domain = undefined;

if (fs.existsSync('./domain.json')) {
  domain = require('./domain.json');
}

var githubSecrets = {
  clientId: 'NO CLIENT ID SET',
  secret: 'NO SECRET SET'
};

if (fs.existsSync('./secrets/github-access-token.json')) {
  githubSecrets = require('./secrets/github-access-token.json');
}

// A stack that holds all the shared resources, like the tables, etc.
class SharedResources extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Network to run everything in
    const vpc = new ec2.VpcNetwork(this, 'NpmFollowerVpc', {
      maxAZs: 2,
      natGateways: 1
    });

    // A table to store the list of changelogs and their metadata in
    const changelogsTable = new dynamodb.Table(this, 'Changelogs', {
      partitionKey: { name: 'changelog', type: dynamodb.AttributeType.String },
      billingMode: dynamodb.BillingMode.PayPerRequest
    });

    // A table to store the list of feeds
    const feedsTable = new dynamodb.Table(this, 'Feeds', {
      partitionKey: { name: 'feed', type: dynamodb.AttributeType.String },
      billingMode: dynamodb.BillingMode.PayPerRequest
    });

    // A table which stores the auto complete search index
    const searchIndexTable = new dynamodb.Table(this, 'search-index', {
      partitionKey: { name: 'fragment', type: dynamodb.AttributeType.String },
      sortKey: { name: 'score', type: dynamodb.AttributeType.String },
      ttlAttributeName: 'validUntil',
      billingMode: dynamodb.BillingMode.PayPerRequest
    });

    // An S3 bucket which holds the web content
    const webBucket = new s3.Bucket(this, 'web-bucket', {
      publicReadAccess: true,
      websiteIndexDocument: 'index.html'
    });

    // An S3 bucket which holds the API content
    const apiBucket = new s3.Bucket(this, 'api-bucket', {
      publicReadAccess: true,
      websiteIndexDocument: 'index.json'
    });

    // An S3 bucket which holds the static content
    const staticBucket = new s3.Bucket(this, 'static-bucket', {
      publicReadAccess: true,
      websiteIndexDocument: 'index.html'
    });

    // Create an ECS cluster
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });

    // An SNS topic to which we can publish to trigger the crawl of a changelog
    const toCrawlTopic = new sns.Topic(this, 'to-crawl', {
      displayName: 'Changelog to crawl'
    });

    const redisCluster = new redis.Cluster(this, 'redis', { vpc });

    this.vpc = vpc;
    this.changelogsTable = changelogsTable;
    this.feedsTable = feedsTable;
    this.searchIndexTable = searchIndexTable;
    this.webBucket = webBucket;
    this.apiBucket = apiBucket;
    this.staticBucket = staticBucket;
    this.toCrawlTopic = toCrawlTopic;
    this.cluster = cluster;
    this.redis = redisCluster;
  }
}

// Lambda function that crawls a specific changelog
class Crawler extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create a lambda that does the crawl
    const crawlLambda = new lambda.Function(this, 'crawl-lambda', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'crawl.handle',
      code: lambda.Code.asset('./app/crawl'),
      timeout: 30,
      vpc: props.vpc,
      environment: {
        GITHUB_CLIENT_ID: githubSecrets.clientId,
        GITHUB_SECRET: githubSecrets.secret,
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        FEEDS_TABLE_NAME: props.feedsTable.tableName,
        SEARCH_INDEX_TABLE_NAME: props.searchIndexTable.tableName,
        API_BUCKET_NAME: props.apiBucket.bucketName,
        WEB_BUCKET_NAME: props.webBucket.bucketName,
        REDIS_HOST: props.redis.cluster.cacheClusterRedisEndpointAddress,
        REDIS_PORT: props.redis.cluster.cacheClusterRedisEndpointPort
      }
    });

    // Attach the lambda to the SNS topic so that when the follower
    // publishes to the SNS topic the Lambda gets invoked.
    const crawlEventSource = new lambdaEvents.SnsEventSource(props.toCrawlTopic);
    crawlLambda.addEventSource(crawlEventSource);

    // Grant the lambda permission to modify the tables
    props.changelogsTable.grantReadWriteData(crawlLambda.role);
    props.feedsTable.grantReadWriteData(crawlLambda.role);
    props.searchIndexTable.grantReadWriteData(crawlLambda.role);

    // Grant the lambda permission to write to the buckets
    props.webBucket.grantReadWrite(crawlLambda.role);
    props.apiBucket.grantReadWrite(crawlLambda.role);

    // Grant the lambda networking access to Redis
    crawlLambda.connections.allowToDefaultPort(props.redis);
  }
}

// Lambda that periodically triggers a recrawl of previously crawled
// changelogs.
class Recrawler extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create a lambda that recrawls changelogs discovered in the past
    const recrawlLambda = new lambda.Function(this, 'recrawl', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'recrawl.handle',
      code: lambda.Code.asset('./app/recrawl'),
      timeout: 360,
      environment: {
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        DISCOVERED_TOPIC_NAME: props.toCrawlTopic.topicArn
      }
    });

    // Grant the lambda permission to modify the tables
    props.changelogsTable.grantReadWriteData(recrawlLambda.role);
    props.toCrawlTopic.grantPublish(recrawlLambda.role);

    // Schedule the recrawler to run once every minute
    this.eventRule = new events.EventRule(this, 'recrawl-check-schedule', {
      scheduleExpression: 'rate(1 minute)',
      targets: [recrawlLambda]
    });
  }
}

// A stack for the the follower app. This is a persistent container
// that acts as a CouchDB follower to monitor NPM's public CouchDB
// interface and get realtime notifications of modified NPM packages
class NpmFollower extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Prior to building the image copy the package.json and libs into
    // the build context since Docker can't reference files outside of the
    // build context.
    copydir.sync('./app/lib', './app/npm-follower/lib');
    copydir.sync('./app', './app/npm-follower', function(stat, filepath, filename) {
      if (stat === 'file' && filename === 'package.json') {
        return true;
      }

      return false;
    });

    // Define the follower application.
    const followerDefinition = new ecs.FargateTaskDefinition(this, 'NpmFollowerDefinition', {});

    followerDefinition.addContainer('npm-follower', {
      image: ecs.ContainerImage.fromAsset(this, 'NpmFollowerImage', {
        directory: './app/npm-follower'
      }),
      memoryMiB: 512,
      cpu: 256,
      environment: {
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        DISCOVERED_TOPIC_NAME: props.toCrawlTopic.topicArn
      },
      logging: new ecs.AwsLogDriver(this, 'npm-follower', {
        streamPrefix: 'npm-follower'
      })
    });

    // Grant this application access to the DynamoDB table and SNS topic
    props.changelogsTable.grantReadWriteData(followerDefinition.taskRole);
    props.toCrawlTopic.grantPublish(followerDefinition.taskRole);

    // Launch the image as a service in Fargate
    this.npmFollower = new ecs.FargateService(this, 'NpmFollower', {
      assignPublicIp: true,
      cluster: props.cluster,  // Required
      cpu: '256',
      memoryMiB: '512',
      desiredCount: 1,
      taskDefinition: followerDefinition,
      createLogs: false
    });
  }
}

// A stack for the PyPI watcher. This is a lambda that runs on a schedule
// and triggers a crawl on the repo of any recently released PyPI python
// package
class PyPIFollower extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create the lambda
    const pypiFollower = new lambda.Function(this, 'pypi-follower', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'pypi-recent.handle',
      code: lambda.Code.asset('./app/pypi-recent'),
      timeout: 60,
      environment: {
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        DISCOVERED_TOPIC_NAME: props.toCrawlTopic.topicArn
      }
    });

    // Grant this application access to the DynamoDB table and SNS topic
    props.changelogsTable.grantReadWriteData(pypiFollower.role);
    props.toCrawlTopic.grantPublish(pypiFollower.role);

    // Schedule the follower to run once every minute
    this.eventRule = new events.EventRule(this, 'check-recent-pypi', {
      scheduleExpression: 'rate(5 minutes)',
      targets: [pypiFollower]
    });
  }
}

// A stack for the RubyGems watcher. This is a lambda that runs on a schedule
// and triggers a crawl on the repo of any recently released Ruby Gem
class RubyGemFollower extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create the lambda
    const rubygemFollower = new lambda.Function(this, 'rubygem-follower', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'rubygem-recent.handle',
      code: lambda.Code.asset('./app/rubygem-recent'),
      timeout: 60,
      environment: {
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        DISCOVERED_TOPIC_NAME: props.toCrawlTopic.topicArn
      }
    });

    // Grant this application access to the DynamoDB table and SNS topic
    props.changelogsTable.grantReadWriteData(rubygemFollower.role);
    props.toCrawlTopic.grantPublish(rubygemFollower.role);

    // Schedule the follower to run once every minute
    this.eventRule = new events.EventRule(this, 'check-recent-rubygems', {
      scheduleExpression: 'rate(5 minutes)',
      targets: [rubygemFollower]
    });
  }
}

class BroadcastSocket extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    const broadcast = new ecs.LoadBalancedFargateService(this, 'Broadcast', {
      image: ecs.ContainerImage.fromAsset(this, 'broadcast-image', {
        directory: './app/socket-broadcast'
      }),
      publicTasks: true,
      cluster: props.cluster,
      cpu: '256',
      memoryMiB: '512',
      desiredCount: 1,
      environment: {
        REDIS_HOST: props.redis.cluster.cacheClusterRedisEndpointAddress,
        REDIS_PORT: props.redis.cluster.cacheClusterRedisEndpointPort
      },
      createLogs: true
    });

    // Grant the broadcast service networking access to Redis
    broadcast.service.connections.allowToDefaultPort(props.redis);

    this.dnsName = broadcast.loadBalancer.dnsName;
  }
}

// Lambda that periodically refreshes the API response that lists the recently
// crawled repositories
class RecentlyCrawled extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create a lambda that returns autocomplete results
    const recentlyCrawled = new lambda.Function(this, 'recently-crawled', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'recently-crawled.handle',
      code: lambda.Code.asset('./app/recently-crawled'),
      environment: {
        FEEDS_TABLE_NAME: props.feedsTable.tableName,
        API_BUCKET_NAME: props.apiBucket.bucketName
      }
    });

    // Grant the lambda permission to modify the tables and S3 bucket
    props.feedsTable.grantReadWriteData(recentlyCrawled.role);
    props.apiBucket.grantReadWrite(recentlyCrawled.role);

    // Schedule the recrawler to run once every minute
    this.eventRule = new events.EventRule(this, 'recrawl-check-schedule', {
      scheduleExpression: 'rate(1 minute)',
      targets: [recentlyCrawled]
    });
  }
}

class Autocompleter extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Create a lambda that returns autocomplete results
    const autocomplete = new lambda.Function(this, 'autocomplete', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'autocomplete.handle',
      code: lambda.Code.asset('./app/autocomplete'),
      environment: {
        SEARCH_INDEX_TABLE_NAME: props.searchIndexTable.tableName
      }
    });

    // Grant the lambda permission to modify the tables
    props.searchIndexTable.grantReadWriteData(autocomplete.role);

    this.autocompleteGateway = new apiGateway.LambdaRestApi(this, 'autocomplete-gateway', {
      handler: autocomplete,
      proxy: true
    });

    this.url = this.autocompleteGateway.url;
  }
}

class WebFrontend extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    // Copy the static files into the static S3 bucket
    this.s3Deployment = new s3Deployment.BucketDeployment(this, 'deploy-web', {
      source: s3Deployment.Source.asset('./static'),
      destinationBucket: props.staticBucket,
    });

    // Create a lambda that regenerates the homepage
    const regenerateHomepage = new lambda.Function(this, 'regenerate-homepage', {
      runtime: lambda.Runtime.NodeJS810,
      handler: 'regenerate-homepage.handle',
      code: lambda.Code.asset('./app/regenerate-homepage'),
      environment: {
        CHANGELOGS_TABLE_NAME: props.changelogsTable.tableName,
        FEEDS_TABLE_NAME: props.feedsTable.tableName,
        WEB_BUCKET_NAME: props.webBucket.bucketName
      }
    });

    // Grant the lambda permission to read the tables
    props.feedsTable.grantReadData(regenerateHomepage.role);
    props.changelogsTable.grantReadData(regenerateHomepage.role);
    props.webBucket.grantReadWrite(regenerateHomepage.role);

    // Schedule this lambda to run once a minute
    this.eventRule = new events.EventRule(this, 'homepage-regeneration-schedule', {
      scheduleExpression: 'rate(1 minute)',
      targets: [regenerateHomepage]
    });
  }
}

class GlobalDistribution extends cdk.Stack {
  constructor(parent, id, props) {
    super(parent, id, props);

    this.dist = new cloudfront.CloudFrontWebDistribution(this, 'MyDistribution', {
      aliasConfiguration: domain,
      originConfigs: [
        // All the static files, like CSS, JS, images, etc
        {
          customOriginSource: {
            domainName: props.staticBucket.bucketName + '.s3-website.' + this.region + '.amazonaws.com',
            originProtocolPolicy: 'http-only'
          },
          behaviors: [
            {
              isDefaultBehavior: true,
              compress: true
            }
          ]
        },
        // The automatically generated HTML files
        {
          customOriginSource: {
            domainName: props.webBucket.bucketName + '.s3-website.' + this.region + '.amazonaws.com',
            originProtocolPolicy: 'http-only'
          },
          behaviors: [
            {
              pathPattern: 'github*',
              compress: true
            },
            {
              pathPattern: 'index.html',
              compress: true
            }
          ]
        },
        // The automatically generated JSON files
        {
          customOriginSource: {
            domainName: props.apiBucket.bucketName + '.s3-website.' + this.region + '.amazonaws.com',
            originProtocolPolicy: 'http-only'
          },
          behaviors: [
            {
              pathPattern: 'api*',
              compress: true
            }
          ]
        },
        // The autocomplete endpoints behind API gateway
        {
          customOriginSource: {
            domainName: props.autocompleteGateway.restApiId + '.execute-api.' + this.region + '.amazonaws.com',
          },
          originPath: '/prod',
          behaviors: [
            {
              pathPattern: 'search*',
              compress: true,
              forwardedValues: { queryString: true, cookies: { forward: 'none' } }
            }
          ]
        },
        // The websocket service which provides live updates to
        // the front facing website
        {
          customOriginSource: {
            domainName: props.broadcast.dnsName,
            originProtocolPolicy: 'http-only'
          },
          behaviors: [
            {
              pathPattern: 'socket.io*',
              forwardedValues: { queryString: true, cookies: { forward: 'all' } }
            }
          ]
        }
      ]
    });
  }
}

class NpmFollowerApp extends cdk.App {
  constructor(argv) {
    super(argv);

    // The stack that holds the shared underlying resources.
    const sharedResources = new SharedResources(this, 'shared-resources');

    // The micro components that make up the application
    this.crawler = new Crawler(this, 'crawler', {
      vpc: sharedResources.vpc,
      redis: sharedResources.redis,
      changelogsTable: sharedResources.changelogsTable,
      feedsTable: sharedResources.feedsTable,
      searchIndexTable: sharedResources.searchIndexTable,
      webBucket: sharedResources.webBucket,
      apiBucket: sharedResources.apiBucket,
      toCrawlTopic: sharedResources.toCrawlTopic
    });

    this.recrawler = new Recrawler(this, 'recrawler', {
      changelogsTable: sharedResources.changelogsTable,
      toCrawlTopic: sharedResources.toCrawlTopic
    });

    this.recentlyCrawled = new RecentlyCrawled(this, 'recently-crawled', {
      feedsTable: sharedResources.feedsTable,
      apiBucket: sharedResources.apiBucket
    });

    this.npmFollower = new NpmFollower(this, 'npm-follower', {
      changelogsTable: sharedResources.changelogsTable,
      toCrawlTopic: sharedResources.toCrawlTopic,
      cluster: sharedResources.cluster,
    });

    this.pypiFollower = new PyPIFollower(this, 'pypi-follower', {
      changelogsTable: sharedResources.changelogsTable,
      toCrawlTopic: sharedResources.toCrawlTopic
    });

    this.rubygemFollower = new RubyGemFollower(this, 'rubygem-follower', {
      changelogsTable: sharedResources.changelogsTable,
      toCrawlTopic: sharedResources.toCrawlTopic
    });

    const broadcast = new BroadcastSocket(this, 'broadcast', {
      redis: sharedResources.redis,
      cluster: sharedResources.cluster
    });

    const autocompleter = new Autocompleter(this, 'autocomplete', {
      searchIndexTable: sharedResources.searchIndexTable
    });

    this.webFrontend = new WebFrontend(this, 'web-frontend', {
      changelogsTable: sharedResources.changelogsTable,
      feedsTable: sharedResources.feedsTable,
      webBucket: sharedResources.webBucket,
      staticBucket: sharedResources.staticBucket
    });

    // A Cloudfront distribution that serves the website
    this.dist = new GlobalDistribution(this, 'cloudfront-distribution', {
      webBucket: sharedResources.webBucket,
      apiBucket: sharedResources.apiBucket,
      staticBucket: sharedResources.staticBucket,
      autocompleteGateway: autocompleter.autocompleteGateway,
      broadcast: broadcast
    });
  }
}

new NpmFollowerApp().run();
