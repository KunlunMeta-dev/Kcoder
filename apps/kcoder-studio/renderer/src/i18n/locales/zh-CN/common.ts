import base from './common.json'
import workbench from './common-workbench.json'

// Both files belong to the existing common namespace; public translation keys stay stable.
export default { ...base, ...workbench }
