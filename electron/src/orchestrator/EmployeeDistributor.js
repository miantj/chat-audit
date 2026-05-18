// electron/src/orchestrator/EmployeeDistributor.js
export class EmployeeDistributor {
  constructor(employees, tabCount = 3) {
    this.employees = employees;
    this.tabCount = tabCount;
    this.assignments = this._computeAssignments();
  }

  _computeAssignments() {
    const result = Array.from({ length: this.tabCount }, () => []);
    this.employees.forEach((emp, i) => {
      result[i % this.tabCount].push(emp);
    });
    return result;
  }

  getForTab(tabIndex) {
    return this.assignments[tabIndex] || [];
  }

  getTotalCount() {
    return this.employees.length;
  }
}