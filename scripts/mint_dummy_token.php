<?php
// Mint a throwaway user + PAT for dummy-provider integration tests.
require __DIR__ . '/../external/pixel-office/vendor/autoload.php';
$app = require __DIR__ . '/../external/pixel-office/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$email = 'dummy-' . bin2hex(random_bytes(4)) . '@example.test';
$user = App\Models\User::create([
    'name'     => 'Dummy Tester',
    'email'    => $email,
    'password' => Illuminate\Support\Facades\Hash::make('password1234'),
]);
[, $plain] = App\Models\UserApiToken::issue($user, 'dummy-test');
echo $plain;
