# Arithmetic fixture

`add(left, right)` returns the sum of two numbers. CI passes the independent fixture through Bake and Crust, checks the generated crate on each declared target, and verifies the module manifest and exported function. No generated native library or executable is required.
