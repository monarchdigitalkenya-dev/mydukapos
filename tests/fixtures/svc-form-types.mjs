// Small hand-made schemas (same shape as SERVICES_ARCHITECTURE.md 2.3) used by tests/svc-form.test.mjs. Independent of svc-templates.
const customer = (quick) => ({ id: 'customer', title: 'Customer', fields: [
  { id: 'cust_name', type: 'text', label: 'Name', required: true, storesIn: 'customer' },
  { id: 'cust_phone', type: 'phone', label: 'Phone', required: 'quickOff', storesIn: 'customer' },
  { id: 'cust_email', type: 'email', label: 'Email', storesIn: 'customer' },
  { id: 'cust_notes', type: 'longtext', label: 'Notes', storesIn: 'customer' }] });
const vehicle = { id: 'vehicle', title: 'Vehicle', icon: 'X', fields: [
  { id: 'veh_plate', type: 'plate', label: 'Number plate', required: true, storesIn: 'asset', assetAttr: 'plate', autocomplete: 'asset' },
  { id: 'veh_make', type: 'combo', label: 'Make', required: true, optionsFrom: 'vehicleMakes', allowOther: true, storesIn: 'asset', assetAttr: 'make' },
  { id: 'veh_model', type: 'combo', label: 'Model', required: true, optionsFrom: 'vehicleModels:veh_make', allowOther: true, storesIn: 'asset', assetAttr: 'model' },
  { id: 'veh_type', type: 'dropdown', label: 'Vehicle type', optionsFrom: 'vehicleTypes', storesIn: 'asset', assetAttr: 'type' },
  { id: 'veh_year', type: 'year', label: 'Year', storesIn: 'asset', assetAttr: 'year' },
  { id: 'veh_odometer', type: 'odometer', label: 'Mileage', storesIn: 'asset', assetAttr: 'odometer' }] };
export const TYPES = {
  car_wash: { key: 'car_wash', version: 1, assetKind: 'vehicle', terms: { customer: 'Owner' },
    quick: { fields: ['veh_plate', 'services'], required: ['veh_plate'], submitLabel: 'Add to queue' },
    staffAssignment: { mode: 'multi', perTask: true, taskLabels: ['Exterior', 'Interior'] },
    sections: [customer(), vehicle,
      { id: 'services', title: 'Services', fields: [{ id: 'services', type: 'widget', widget: 'services', label: 'Services', required: true }] },
      { id: 'condition', title: 'Vehicle condition', fields: [{ id: 'cond_scratches', type: 'text', label: 'Existing scratches' }, { id: 'cond_photos', type: 'photo', label: 'Condition photos' }] },
      { id: 'valuables', title: 'Valuables', fields: [{ id: 'valuables', type: 'widget', widget: 'valuables', label: 'Items left in vehicle' }, { id: 'val_ack', type: 'checkbox', label: 'Customer acknowledges', visibleWhen: { field: 'valuables', truthy: true } }] },
      { id: 'staff', title: 'Staff', fields: [{ id: 'staff', type: 'widget', widget: 'staff', label: 'Assigned staff', multiple: true }] }] },
  garage: { key: 'garage', version: 1, assetKind: 'vehicle',
    sections: [customer(), vehicle,
      { id: 'complaint', title: 'Complaint', fields: [{ id: 'cmp_problem', type: 'longtext', label: 'Reported problem', required: true }, { id: 'cmp_symptoms', type: 'longtext', label: 'Symptoms' }] },
      { id: 'repair', title: 'Repair', fields: [{ id: 'mechanic', type: 'staff', label: 'Mechanic', role: 'mechanic' }, { id: 'rep_labour', type: 'money', label: 'Labour' }] }] },
  phone_repair: { key: 'phone_repair', version: 1, assetKind: 'phone',
    sections: [customer(),
      { id: 'device', title: 'Device', fields: [
        { id: 'dev_type', type: 'dropdown', label: 'Device type', required: true, options: [{ v: 'phone', l: 'Phone' }, { v: 'tablet', l: 'Tablet' }, { v: 'laptop', l: 'Laptop' }] },
        { id: 'dev_brand', type: 'combo', label: 'Brand', required: true, optionsFrom: 'phoneBrands', allowOther: true },
        { id: 'dev_model', type: 'text', label: 'Model', required: true },
        { id: 'dev_imei', type: 'imei', label: 'IMEI', level: 'warn', visibleWhen: { field: 'dev_type', in: ['phone', 'tablet'] }, storesIn: 'asset', assetAttr: 'imei', autocomplete: 'asset' },
        { id: 'dev_accessories', type: 'chips', label: 'Accessories', options: ['Charger', 'SIM', 'Case'] },
        { id: 'dev_passcode', type: 'text', label: 'Passcode', sensitive: true }] },
      { id: 'problem', title: 'Problem', fields: [{ id: 'rep_problem', type: 'longtext', label: 'Reported problem', required: true }] }] },
  salon: { key: 'salon', version: 1, assetKind: 'none', terms: { customer: 'Client' },
    quick: { fields: ['cust_name', 'services'], required: ['services'] },
    sections: [{ id: 'client', title: 'Client', fields: [{ id: 'cust_name', type: 'text', labelTerm: 'customer', label: 'Client name', required: 'quickOff', storesIn: 'customer' }, { id: 'cust_phone', type: 'phone', label: 'Phone', storesIn: 'customer' }] },
      { id: 'appt', title: 'Appointment / Walk-in', fields: [
        { id: 'appt_mode', type: 'dropdown', label: 'Type', options: [{ v: 'walk_in', l: 'Walk-in' }, { v: 'booking', l: 'Booking' }], default: 'walk_in' },
        { id: 'appt_date', type: 'date', label: 'Date', required: true, visibleWhen: { field: 'appt_mode', eq: 'booking' } },
        { id: 'appt_time', type: 'time', label: 'Time', required: true, visibleWhen: { field: 'appt_mode', eq: 'booking' } },
        { id: 'appt_deposit', type: 'money', label: 'Deposit' }] },
      { id: 'services', title: 'Services', fields: [{ id: 'services', type: 'service-picker', label: 'Services', required: true }] }] },
};
export const CATALOG = [{ id: 'sc-1', name: 'Basic Wash', price: 500 }, { id: 'sc-2', name: 'Premium Wash', price: 1500 }];
export const STAFF = [{ id: 'st-1', name: 'Peter' }, { id: 'st-2', name: 'James' }];
export const MODELS = { Toyota: ['Premio', 'Allion'], Nissan: ['Note'] };
