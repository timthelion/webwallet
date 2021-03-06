'use strict';

angular.module('webwalletApp').constant('config', {
  // show debug information in the interface
  debug: false,

  // address of the plugin configuration file
  pluginConfigUrl: '/data/plugin/config_signed.bin',

  // minimal version of plugin this wallet supports
  pluginMinVersion: '1.0.5',

  // version of storage this wallet is compatible with
  storageVersion: '1.1.0',

  // fee per kb for new txs
  feePerKb: 10000,

  // default coin name for new accounts
  coin: 'Bitcoin',

  // coin name -> backend config
  backends: {
    Bitcoin: {
      endpoint: 'https://mytrezor.com',
      after: '2014-01-01',
      lookAhead: 40,
      firstIndex: 0
    },
    Testnet: {
      endpoint: 'http://test-api.bitsofproof.com:8080',
      after: '2014-01-01',
      lookAhead: 40,
      firstIndex: 0
    }
  },

  // coin name -> public address version
  versions: {
    Bitcoin: 76067358,
    Testnet: 76067358, // 70617039
  },

  // coin name -> address type -> script type
  scriptTypes: {
    Bitcoin: {
      5: 'PAYTOSCRIPTHASH'
    }
  },

  // coin name -> bip32 tree index
  indices: {
    Bitcoin: 0,
    Testnet: 1
  },

  useBip44: true

});
