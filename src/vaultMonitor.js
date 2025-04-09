const axios = require('axios');
require("dotenv").config();
const TelegramNotifier = require('./telegram');

// Morpho Blue API endpoint
const MORPHO_API_URL = 'https://blue-api.morpho.org/graphql';

// Configuration from environment variables
const VAULT_1 = process.env.VAULT_1_ADDRESS || '';
const VAULT_2 = process.env.VAULT_2_ADDRESS || '';
const APY_DIFF_THRESHOLD = parseFloat(process.env.APY_DIFF_THRESHOLD || '0.00'); // 0.1% difference threshold
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '600') * 1000; // Check every 10 Mins by default
const ALERT_COOLDOWN = parseInt(process.env.ALERT_COOLDOWN || '600') * 1000; // Alert cooldown (10 mins by default)
const CHAIN_ID = process.env.CHAIN_ID || '8453'; // Default to 8453 (BASE)

// GraphQL query to fetch vault data
const query = `
query {
  vaults(where: { chainId_in: [${CHAIN_ID}] }, first: 200) {
    items {
      address
      symbol
      name
      asset {
        address
        symbol
        decimals
      }
      chain {
        id
        network
      }
      state {
        apy
        netApy
        totalAssets
        totalAssetsUsd
        fee
        timelock
        rewards {
          asset {
            address
            symbol
            name
          }
          supplyApr
          yearlySupplyTokens
          amountPerSuppliedToken
        }
        allocation {
          supplyAssets
          supplyAssetsUsd
          market {
            uniqueKey
            loanAsset {
              symbol
              name
              address
            }
            collateralAsset {
              symbol
              name
              address
            }
            state {
              supplyApy
              netSupplyApy
              rewards {
                supplyApr
                asset {
                  address
                  symbol
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Helper functions to handle data extraction and formatting if empty
function safeGet(obj, path, defaultValue = 'N/A') {
  try {
    const keys = path.split('.');
    let current = obj;
    
    for (const key of keys) {
      if (current === null || current === undefined || !Object.prototype.hasOwnProperty.call(current, key)) {
        return defaultValue;
      }
      current = current[key];
    }
    
    return current === null || current === undefined ? defaultValue : current;
  } catch (error) {
    return defaultValue;
  }
}

// Format percentages for better readability
function formatPercentage(value) {
  if (value === null || value === undefined || value === 'N/A') return 'N/A';
  return (parseFloat(value) * 100).toFixed(2) + '%';
}

// Calculate total rewards APR
function calculateTotalRewardsApr(vault) {
  let totalRewardsApr = 0;
  
  // Direct vault rewards
  if (safeGet(vault, 'state.rewards', []).length > 0) {
    for (const reward of vault.state.rewards) {
      if (reward.supplyApr) {
        totalRewardsApr += parseFloat(reward.supplyApr);
      }
    }
  }
  
  // Market allocation rewards
  if (safeGet(vault, 'state.allocation', []).length > 0) {
    let totalAllocatedAssets = 0;
    
    // Calculate total allocated assets for weighting
    for (const allocation of vault.state.allocation) {
      if (allocation.supplyAssetsUsd) {
        totalAllocatedAssets += parseFloat(allocation.supplyAssetsUsd);
      }
    }
    
    // Calculate weighted market rewards
    if (totalAllocatedAssets > 0) {
      for (const allocation of vault.state.allocation) {
        if (allocation.supplyAssetsUsd && allocation.market) {
          const weight = parseFloat(allocation.supplyAssetsUsd) / totalAllocatedAssets;
          
          const marketRewards = safeGet(allocation, 'market.state.rewards', []);
          for (const reward of marketRewards) {
            if (reward.supplyApr) {
              totalRewardsApr += parseFloat(reward.supplyApr) * weight;
            }
          }
        }
      }
    }
  }
  
  return totalRewardsApr;
}

class VaultMonitor {
  constructor() {
    this.lastAlertTime = 0;
    this.alertCooldown = ALERT_COOLDOWN;
    this.lastVault1NetApy = null;
    this.lastVault2NetApy = null;
    
    // Initialize Telegram notifier
    this.telegram = new TelegramNotifier(
      process.env.TOKEN,
      process.env.CHANNEL
    );
  }
  
  async fetchVaultData() {
    try {
      const response = await axios.post(
        MORPHO_API_URL,
        { query },
        {
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      // Get all chain vaults
      const allVaults = response.data.data.vaults.items;
      
      // Filter to get only the vaults we're interested in
      const targetVaults = allVaults.filter(vault => 
        [VAULT_1.toLowerCase(), VAULT_2.toLowerCase()].includes(vault.address.toLowerCase())
      );
      
      if (targetVaults.length !== 2) {
        console.log(`Warning: Expected 2 vaults, but found ${targetVaults.length}`);
        return null;
      }

      // Calculate rewards APR and total APYs for each vault
      const vaultsWithTotals = targetVaults.map(vault => {
        const rewardsApr = calculateTotalRewardsApr(vault);
        const baseApy = parseFloat(safeGet(vault, 'state.apy', 0));
        const netApy = parseFloat(safeGet(vault, 'state.netApy', 0));
        
        return {
          ...vault,
          calculatedRewardsApr: rewardsApr,
          totalApy: baseApy + rewardsApr,
          totalNetApy: netApy + rewardsApr
        };
      });
      
      return vaultsWithTotals;
    } catch (error) {
      console.error('Error fetching vault data:', error.message);
      if (error.response) {
        console.error('API response:', error.response.data);
      }
      return null;
    }
  }
  
  async logAlert(message) {
    const currentTime = Date.now();

    if (currentTime - this.lastAlertTime < this.alertCooldown) {
      console.log("Alert cooldown in effect");
      return;
    }

    console.log(message);
    // Send Telegram notification
    await this.telegram.sendMessage(message);

    this.lastAlertTime = currentTime;
  }
  
  async monitorVaults() {
    console.log(`Starting Morpho vault APY monitor for vaults:`);
    console.log(`Vault 1: ${VAULT_1}`);
    console.log(`Vault 2: ${VAULT_2}`);
    console.log(`APY difference threshold: ${APY_DIFF_THRESHOLD * 100}%`);
    console.log(`Checking every ${CHECK_INTERVAL / 1000} seconds`);
    console.log(`Alert cooldown: ${ALERT_COOLDOWN / 1000} seconds`);

    // Send a telegram message to indicate the start of monitoring
    const startMessage = `
<b>📊 Morpho Vault APY Monitor Started 📊</b>
Monitoring vaults:
- Vault 1: ${VAULT_1}
- Vault 2: ${VAULT_2}
APY difference threshold: ${APY_DIFF_THRESHOLD * 100}%
Checking interval: ${CHECK_INTERVAL / 1000} seconds
Alert cooldown: ${ALERT_COOLDOWN / 1000} seconds
`;
    await this.telegram.sendMessage(startMessage);
    
    const monitor = async () => {
      try {
        const vaultsData = await this.fetchVaultData();

        if (!vaultsData || vaultsData.length !== 2) {
          console.log("Could not fetch both vault data, will retry");
          return;
        }

        const vault1 = vaultsData.find(v => v.address.toLowerCase() === VAULT_1.toLowerCase());
        const vault2 = vaultsData.find(v => v.address.toLowerCase() === VAULT_2.toLowerCase());
        
        if (!vault1 || !vault2) {
          console.log("Could not find both vaults in the data, will retry");
          return;
        }
        
        const vault1NetApy = vault1.totalNetApy;
        const vault2NetApy = vault2.totalNetApy;
        const apyDiff = vault1NetApy - vault2NetApy;
        const absDiff = Math.abs(apyDiff);
        
        // Format the values for display
        console.log("-----------------------------------");
        console.log(new Date().toISOString());
        console.log(`${vault1.name} Total Net APY: ${formatPercentage(vault1NetApy)}`);
        console.log(`${vault2.name} Total Net APY: ${formatPercentage(vault2NetApy)}`);
        console.log(`APY Difference: ${formatPercentage(apyDiff)} (Absolute: ${formatPercentage(absDiff)})`);
        
        // Track APY changes
        let apyChanged = false;
        let changeMessage = "";
        
        if (this.lastVault1NetApy !== null && this.lastVault2NetApy !== null) {
          const vault1Change = vault1NetApy - this.lastVault1NetApy;
          const vault2Change = vault2NetApy - this.lastVault2NetApy;
          
          console.log(`${vault1.name} APY Change: ${formatPercentage(vault1Change)}`);
          console.log(`${vault2.name} APY Change: ${formatPercentage(vault2Change)}`);
          
          if (Math.abs(vault1Change) > 0.0001 || Math.abs(vault2Change) > 0.0001) {
            apyChanged = true;
            changeMessage = `
<b>APY Changes:</b>
- ${vault1.name}: ${formatPercentage(this.lastVault1NetApy)} → ${formatPercentage(vault1NetApy)} (${vault1Change > 0 ? '+' : ''}${formatPercentage(vault1Change)})
- ${vault2.name}: ${formatPercentage(this.lastVault2NetApy)} → ${formatPercentage(vault2NetApy)} (${vault2Change > 0 ? '+' : ''}${formatPercentage(vault2Change)})
`;
          }
        }
        
        // Update last APY values
        this.lastVault1NetApy = vault1NetApy;
        this.lastVault2NetApy = vault2NetApy;
        
        // Check if we need to send an alert
        const betterVault = apyDiff > 0 ? vault1 : vault2;
        const worseVault = apyDiff > 0 ? vault2 : vault1;
        
        // Alert if the APY difference exceeds the threshold OR if APYs changed significantly
        if (absDiff >= APY_DIFF_THRESHOLD || apyChanged) {
          const message = `
<b>🔄 Morpho Vault APY Update 🔄</b>

<b>Current APY Comparison:</b>
- ${vault1.name}: ${formatPercentage(vault1NetApy)}
- ${vault2.name}: ${formatPercentage(vault2NetApy)}
- Difference: ${formatPercentage(absDiff)}

${apyChanged ? changeMessage : ''}

<b>Recommendation:</b> ${betterVault.name} currently offers better returns (higher by ${formatPercentage(absDiff)}) than ${worseVault.name}.

<b>Other Factors:</b>
- Timelock: ${vault1.name} (${safeGet(vault1, 'state.timelock', 'N/A')} sec) vs ${vault2.name} (${safeGet(vault2, 'state.timelock', 'N/A')} sec)
- TVL: ${vault1.name} (${parseFloat(safeGet(vault1, 'state.totalAssetsUsd', 0)).toFixed(2)}) vs ${vault2.name} (${parseFloat(safeGet(vault2, 'state.totalAssetsUsd', 0)).toFixed(2)})
`;
          
          await this.logAlert(message);
        }
      } catch (error) {
        console.error("Error in monitoring loop:", error);
      }
    };

    // Initial check
    await monitor();

    // Interval for regular checks
    setInterval(monitor, CHECK_INTERVAL);
  }
}

// Run the monitor
(async () => {
  const monitor = new VaultMonitor();
  await monitor.monitorVaults();
})();