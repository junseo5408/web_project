document.querySelectorAll('.demo-accounts [data-user]').forEach(function (b) {
  b.addEventListener('click', function () {
    document.getElementById('username').value = b.dataset.user;
    document.getElementById('password').value = 'pass1234';
    document.getElementById('password').focus();
  });
});
