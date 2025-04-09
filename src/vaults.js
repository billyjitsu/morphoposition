const axios = require('axios');
const fs = require('fs');
const path = require('path');
require("dotenv").config();

// Morpho Blue API endpoint
const MORPHO_API_URL = 'https://blue-api.morpho.org/graphql';

// Vault addresses to compare
const VAULT_1 = process.env.VAULT_1_ADDRESS || '';
const VAULT_2 = process.env.VAULT_2_ADDRESS || '';
const CHAIN_ID = process.env.CHAIN_ID || '8453'; // Default to 8453 (BASE)

// Output file path
const OUTPUT_FILE = path.join(__dirname, 'base_vaults.json');

// GraphQL query to fetch all vaults with detailed allocation information
const query = `
query {
  vaults(where: { chainId_in: [${CHAIN_ID}] }, first: 200) {
    items {
      address
      symbol
      name
      creationTimestamp
      creationBlockNumber
      whitelisted
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
            lltv
            irmAddress
            state {
              supplyApy
              borrowApy
              netSupplyApy
              rewards {
                supplyApr
                amountPerSuppliedToken
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
    pageInfo {
      countTotal
      count
      skip
      limit
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

// Format currency values with commas
function formatCurrency(value, decimals = 2) {
  if (value === null || value === undefined || value === 'N/A') return 'N/A';
  return parseFloat(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
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
          // console.log(`Allocation weight: ${weight}`);
          
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

async function fetchAndSaveVaults() {
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
    const pageInfo = response.data.data.vaults.pageInfo;
    
    console.log(`Found ${allVaults.length} vaults on BASE chain.`);
    console.log(`Total vaults: ${pageInfo.countTotal}, Limit: ${pageInfo.limit}, Skipped: ${pageInfo.skip}`);
    
    if (pageInfo.countTotal > pageInfo.limit) {
      console.log(`Note: There are ${pageInfo.countTotal} total vaults, but only ${pageInfo.limit} were returned.`);
    }
    
    // Save all vaults to a JSON file
    fs.writeFileSync(
      OUTPUT_FILE, 
      JSON.stringify(allVaults, null, 2), 
      'utf8'
    );
    
    console.log(`\nSaved all vault information to ${OUTPUT_FILE}`);
    
    // Filter to get only the vaults we're interested in
    const targetVaults = allVaults.filter(vault => 
      [VAULT_1.toLowerCase(), VAULT_2.toLowerCase()].includes(vault.address.toLowerCase())
    );
    
    if (targetVaults.length === 0) {
      console.log(`\nNo data found for the specified vault addresses on chain ${CHAIN_ID}.`);
      console.log('Please check the JSON file for the correct addresses.');
      return;
    }

    // Print the addresses we found
    console.log('\nFound the following target vaults:');
    targetVaults.forEach(vault => {
      console.log(`- ${vault.name}: ${vault.address}`);
    });
    
    // Check which vault was not found
    const foundAddresses = targetVaults.map(v => v.address.toLowerCase());
    if (!foundAddresses.includes(VAULT_1.toLowerCase())) {
      console.log(`\nThe vault (${VAULT_1}) was not found.`);
    }
    if (!foundAddresses.includes(VAULT_2.toLowerCase())) {
      console.log(`\nThe vault (${VAULT_2}) was not found.`);
    }
    
    // Create a comparison table
    if (targetVaults.length > 0) {
      console.log('\n=== MORPHO VAULT DETAILS ===\n');
      
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
      
      // Display data for each vault
      vaultsWithTotals.forEach(vault => {
        console.log(`Vault Name: ${safeGet(vault, 'name')} (${safeGet(vault, 'symbol')})`);
        console.log(`Address: ${safeGet(vault, 'address')}`);
        console.log(`Chain: ${safeGet(vault, 'chain.network')} (ID: ${safeGet(vault, 'chain.id')})`);
        console.log(`Asset: ${safeGet(vault, 'asset.symbol')}`);
        console.log(`Base APY: ${formatPercentage(safeGet(vault, 'state.apy'))}`);
        console.log(`Net APY (after fees): ${formatPercentage(safeGet(vault, 'state.netApy'))}`);
        console.log(`Rewards APR: ${formatPercentage(vault.calculatedRewardsApr)}`);
        console.log(`Total APY (Base + Rewards): ${formatPercentage(vault.totalApy)}`);
        console.log(`Total Net APY (Net + Rewards): ${formatPercentage(vault.totalNetApy)}`);
        console.log(`Total Assets: ${formatCurrency(safeGet(vault, 'state.totalAssets'))} ${safeGet(vault, 'asset.symbol')}`);
        console.log(`Total Assets USD: $${formatCurrency(safeGet(vault, 'state.totalAssetsUsd'))}`);
        console.log(`Fee: ${formatPercentage(safeGet(vault, 'state.fee'))}`);
        console.log(`Timelock: ${safeGet(vault, 'state.timelock')} seconds`);
        
        // Display direct vault rewards if available
        const vaultRewards = safeGet(vault, 'state.rewards', []);
        if (vaultRewards.length > 0) {
          console.log('\nDirect Vault Rewards:');
          vaultRewards.forEach(reward => {
            console.log(`- ${safeGet(reward, 'asset.symbol', safeGet(reward, 'asset.address'))}: APR ${formatPercentage(safeGet(reward, 'supplyApr'))}`);
          });
        } else {
          console.log('\nNo direct vault rewards.');
        }
        
        // Display detailed market allocations
        console.log('\nMarket Allocations:');
        
        const allocations = safeGet(vault, 'state.allocation', []);
        if (allocations.length > 0) {
          // Calculate total allocated assets for percentage calculation
          const totalAllocatedAssetsUsd = allocations.reduce((sum, allocation) => {
            return sum + (parseFloat(safeGet(allocation, 'supplyAssetsUsd', 0)));
          }, 0);
          
          // Sort allocations by USD value (descending)
          const sortedAllocations = [...allocations].sort((a, b) => {
            return (parseFloat(safeGet(b, 'supplyAssetsUsd', 0))) - (parseFloat(safeGet(a, 'supplyAssetsUsd', 0)));
          });
          
          sortedAllocations.forEach((allocation, index) => {
            const allocationPercentage = totalAllocatedAssetsUsd > 0 
              ? (parseFloat(safeGet(allocation, 'supplyAssetsUsd', 0)) / totalAllocatedAssetsUsd * 100).toFixed(2) + '%'
              : 'N/A';
            
            console.log(`\nMarket #${index + 1} (${allocationPercentage} of total allocation):`);
            console.log(`- Loan Asset: ${safeGet(allocation, 'market.loanAsset.symbol')}`);
            console.log(`- Collateral Asset: ${safeGet(allocation, 'market.collateralAsset.symbol')}`);
            console.log(`- Supply APY: ${formatPercentage(safeGet(allocation, 'market.state.supplyApy'))}`);
            console.log(`- Net Supply APY: ${formatPercentage(safeGet(allocation, 'market.state.netSupplyApy'))}`);
            console.log(`- Allocated Assets: ${formatCurrency(safeGet(allocation, 'supplyAssets'))} ${safeGet(vault, 'asset.symbol')}`);
            console.log(`- Allocated USD: $${formatCurrency(safeGet(allocation, 'supplyAssetsUsd'))}`);
            
            // Display market rewards
            const marketRewards = safeGet(allocation, 'market.state.rewards', []);
            if (marketRewards.length > 0) {
              console.log('  Market Rewards:');
              marketRewards.forEach(reward => {
                console.log(`  - ${safeGet(reward, 'asset.symbol', safeGet(reward, 'asset.address'))}: APR ${formatPercentage(safeGet(reward, 'supplyApr'))}`);
              });
            } else {
              console.log('  No market rewards.');
            }
          });
        } else {
          console.log('No market allocations found.');
        }
        
        console.log('-'.repeat(60));
      });
      
      // Determine which vault has better APY if we found both
      if (vaultsWithTotals.length === 2) {
        const [vault1, vault2] = vaultsWithTotals;
        const totalNetApyDiff = vault1.totalNetApy - vault2.totalNetApy;
        
        // Debugging
        console.log(`APY of ${safeGet(vault1, 'name')}: ${formatPercentage(vault1.totalNetApy)} and APY of ${safeGet(vault2, 'name')}: ${formatPercentage(vault2.totalNetApy)}`);
        console.log(`Raw APY difference: ${totalNetApyDiff}`);
        
        console.log('\n=== APY COMPARISON RESULT ===\n');
        
        // Consider differences smaller than 0.005% (which would round to 0.00%) as effectively equal
        if (Math.abs(totalNetApyDiff) < 0.00005) {
          console.log('Both vaults offer effectively the same Total Net APY.');
          
          // If APYs are the same, consider other factors
          const vault1Timelock = parseInt(safeGet(vault1, 'state.timelock', 0));
          const vault2Timelock = parseInt(safeGet(vault2, 'state.timelock', 0));
          
          if (vault1Timelock < vault2Timelock) {
            console.log(`Recommendation: ${safeGet(vault1, 'name')} offers the same returns but with a shorter timelock.`);
          } else if (vault2Timelock < vault1Timelock) {
            console.log(`Recommendation: ${safeGet(vault2, 'name')} offers the same returns but with a shorter timelock.`);
          } else {
            console.log('Both vaults have identical APY and timelock periods.');
          }
        } else if (totalNetApyDiff > 0) {
          console.log(`${safeGet(vault1, 'name')} has a higher Total Net APY by ${formatPercentage(Math.abs(totalNetApyDiff))}`);
          console.log(`Recommendation: ${safeGet(vault1, 'name')} currently offers better returns including rewards.`);
        } else {
          console.log(`${safeGet(vault2, 'name')} has a higher Total Net APY by ${formatPercentage(Math.abs(totalNetApyDiff))}`);
          console.log(`Recommendation: ${safeGet(vault2, 'name')} currently offers better returns including rewards.`);
        }
        
        // Only show the timelock comparison if we didn't already include it in the APY comparison
        if (Math.abs(totalNetApyDiff) >= 0.00005) {
          // Timelock comparison
          const vault1Timelock = parseInt(safeGet(vault1, 'state.timelock', 0));
          const vault2Timelock = parseInt(safeGet(vault2, 'state.timelock', 0));
          
          if (vault1Timelock !== vault2Timelock) {
            const shorterTimelockVault = vault1Timelock < vault2Timelock ? safeGet(vault1, 'name') : safeGet(vault2, 'name');
            const timeDiffDays = Math.abs(vault1Timelock - vault2Timelock) / 86400; // Convert seconds to days
            
            console.log(`\nTimelock Comparison: ${shorterTimelockVault} has a shorter timelock by ${timeDiffDays.toFixed(1)} days.`);
            console.log(`This means you can withdraw your funds faster from ${shorterTimelockVault} if needed.`);
          }
        }
      }
    }
    
  } catch (error) {
    console.error('Error fetching vault data:', error.message);
    if (error.response) {
      console.error('API response:', error.response.data);
    }
  }
}

fetchAndSaveVaults();