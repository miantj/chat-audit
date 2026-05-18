function sameDateRange(actual = [], expected = []) {
  if (actual.length !== expected.length) {
    return false;
  }
  return actual.every((value, index) => value === expected[index]);
}

export function getDialogFilterAdjustments(actual, expected) {
  const adjustments = {};

  if (
    expected.dateRange &&
    !sameDateRange(actual.dateRange, expected.dateRange)
  ) {
    adjustments.dateRange = expected.dateRange;
  }

  if (
    expected.categoryIncludes &&
    !(actual.categoryText || '').includes(expected.categoryIncludes)
  ) {
    adjustments.category = expected.categoryIncludes;
  }

  if (expected.activeTab && actual.activeTabText !== expected.activeTab) {
    adjustments.activeTab = expected.activeTab;
  }

  return adjustments;
}

export async function setDialogDateRange(pageClient, dateRange) {
  if (!dateRange || dateRange.length !== 2) return { ok: false };
  const [d1, d2] = dateRange;
  const result = await pageClient.evaluate(
    ({ d1, d2 }) => {
      const dialog = document.querySelector('.el-dialog__body');
      if (!dialog) return 'no dialog';
      const picker = dialog.querySelector('.el-date-editor--daterange');
      if (!picker) return 'no picker';
      const vm = picker.__vue__;
      if (!vm) return 'no vue';
      const parseDate = (s) => {
        const [y, m, d] = s.split('-').map(Number);
        return new Date(y, m - 1, d);
      };
      const date1 = parseDate(d1);
      const date2 = parseDate(d2);
      vm.minDate = date1;
      vm.maxDate = date2;
      vm.rangeState = { endDate: date2, selecting: false };
      vm.value = [date1, date2];
      vm.pickerValue = [date1, date2];
      vm.$emit('input', [date1, date2]);
      vm.$forceUpdate();
      const fmt = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      const inputs = picker.querySelectorAll('input');
      if (inputs.length >= 2) {
        inputs[0].value = fmt(date1);
        inputs[1].value = fmt(date2);
        inputs[0].dispatchEvent(new Event('input', {bubbles:true}));
        inputs[0].dispatchEvent(new Event('change', {bubbles:true}));
        inputs[1].dispatchEvent(new Event('input', {bubbles:true}));
        inputs[1].dispatchEvent(new Event('change', {bubbles:true}));
      }
      return inputs.length >= 2 ? `${inputs[0].value} ~ ${inputs[1].value}` : 'n/a';
    },
    { d1, d2 }
  );
  return { ok: typeof result === 'string' && result.includes(d1) };
}

export function validateDialogFilters(actual, expected) {
  const errors = [];

  if (expected.employeeName && actual.title !== expected.employeeName) {
    errors.push('employeeName');
  }

  if (expected.dateRange && !sameDateRange(actual.dateRange, expected.dateRange)) {
    errors.push('dateRange');
  }

  if (
    expected.categoryIncludes &&
    !(actual.categoryText || '').includes(expected.categoryIncludes)
  ) {
    errors.push('category');
  }

  if (expected.activeTab && actual.activeTabText !== expected.activeTab) {
    errors.push('activeTab');
  }

  return {
    ok: errors.length === 0,
    errors
  };
}
