// Copyright © 2020 IOHK
// License: Apache-2.0

/**
 * Module for starting and managing the cardano-wallet process.
 *
 * The main function is [[startCardanoWallet]].
 *
 * @packageDocumentation
 */

import path from 'path';
import getPort from 'get-port';

import _ from 'lodash';

import { WriteStream } from 'fs';
import * as cardanoNode from './cardanoNode';
import * as jormungandr from './jormungandr';
import { ServerTlsConfiguration } from './tls';
import { StartService, ShutdownMethod } from './service';
import { DirPath } from './common';

/*******************************************************************************
 * Configuration
 ******************************************************************************/

/**
 * Configuration parameters for starting the wallet backend and node.
 */
export interface LaunchConfig {
  /**
   * Directory to store wallet databases, the blockchain, socket
   * files, etc.
   */
  stateDir: string;

  /**
   * Label for the network that will connected. This is used in the
   * state directory path name.
   */
  networkName: string;

  /**
   * TCP port to use for the `cardano-wallet` API server.
   * The default is to select any free port.
   */
  apiPort?: number;

  /**
   * IP address or hostname to bind the `cardano-wallet` API server
   * to. Can be an IPv[46] address, hostname, or `'*'`. Defaults to
   * 127.0.0.1.
   */
  listenAddress?: string;

  /**
   * Overrides the URL to the zip file containing stake pool metadata
   * which is downloaded by cardano-wallet.
   *
   * This is only useful in testing scenarios, or when running a local
   * development testnet.
   *
   * For Jörmungandr ITN, the default is
   * https://github.com/cardano-foundation/incentivized-testnet-stakepool-registry/archive/master.zip.
   */
  stakePoolRegistryUrl?: string;

  /**
   * The API base URL of the Stake Pool Metadata Aggregation Server (SMASH)
   * which is used by cardano-wallet.
   */
  smashUrl?: string;

  /**
   * Maximum time difference (in seconds) between the tip slot and the
   * latest applied block within which we consider a wallet being
   * synced with the network. Defaults to 300 seconds.
   */
  syncToleranceSeconds?: number;

  /**
   * Configuration for starting `cardano-node`. The `kind` property will be one of
   *  * `"byron"` - [[ByronNodeConfig]]
   *  * `"shelley"` - [[ShelleyNodeConfig]]
   *  * `"jormungandr"` - [[JormungandrConfig]]
   */
  nodeConfig: cardanoNode.CardanoNodeConfig | jormungandr.JormungandrConfig;

  /**
   *  WriteStreams for the child process data events from stdout and stderr
   */
  childProcessLogWriteStreams?: {
    node: WriteStream;
    wallet: WriteStream;
  };

  /**
   *  Control the termination signal handling. Set this to false if the default
   *  behaviour interferes with your application shutdown behaviour.
   *  If setting this to false, ensure stop(0) is called as part of the shutdown.
   */
  installSignalHandlers?: boolean;

  /**
   * Paths to server TLS credentials for establishing a HTTPS connection using TLS
   * If not set, the connection will be served insecurely over HTTP.
   */
  tlsConfiguration?: ServerTlsConfiguration;
}

/*******************************************************************************
 * Starting the wallet
 ******************************************************************************/

export interface WalletStartService extends StartService {
  apiPort: number;
}

export async function startCardanoWallet(
  baseDir: DirPath,
  config: LaunchConfig
): Promise<WalletStartService> {
  const apiPort = config.apiPort || (await getPort());
  const base: WalletStartService = {
    command: `cardano-wallet-${config.nodeConfig.kind}`,
    args: [
      'serve',
      '--shutdown-handler',
      '--port',
      '' + apiPort,
      '--database',
      path.join(baseDir, 'wallets'),
    ].concat(
      config.listenAddress ? ['--listen-address', config.listenAddress] : [],
      config.tlsConfiguration
        ? [
            '--tls-ca-cert',
            config.tlsConfiguration.caCert,
            '--tls-sv-cert',
            config.tlsConfiguration.svCert,
            '--tls-sv-key',
            config.tlsConfiguration.svKey,
          ]
        : [],
      config.smashUrl ? ['--smash-url', config.smashUrl] : [],
      config.syncToleranceSeconds
        ? ['--sync-tolerance', `${config.syncToleranceSeconds}s`]
        : []
    ),
    extraEnv: config.stakePoolRegistryUrl
      ? {
          CARDANO_WALLET_STAKE_POOL_REGISTRY_URL: config.stakePoolRegistryUrl,
        }
      : undefined,
    shutdownMethod: ShutdownMethod.CloseStdin,
    apiPort,
  };
  const addArgs = (args: string[]): WalletStartService =>
    _.assign(base, { args: base.args.concat(args) });

  switch (config.nodeConfig.kind) {
    case 'jormungandr':
      return addArgs([
        '--genesis-block-hash',
        config.nodeConfig.network.genesisBlock.hash,
        '--node-port',
        '' + config.nodeConfig.restPort,
      ]);
    default:
      if (
        config.networkName !== 'mainnet' &&
        !config.nodeConfig.network.genesisFile
      ) {
        throw new Error('genesisFile must be configured');
      }

      const genesisArg =
        config.networkName == 'mainnet'
          ? ''
          : path.join(
              config.nodeConfig.configurationDir,
              config.nodeConfig.network.genesisFile as string
            );

      let networkArg;
      switch (config.networkName) {
        case 'mainnet':
          networkArg = ['--mainnet'];
          break;

        case 'staging':
          networkArg = ['--staging', genesisArg];
          break;

        default:
          networkArg = ['--testnet', genesisArg];
          break;
      }

      return addArgs(
        networkArg.concat(
          config.nodeConfig.socketFile
            ? ['--node-socket', config.nodeConfig.socketFile]
            : []
        )
      );
  }
}
